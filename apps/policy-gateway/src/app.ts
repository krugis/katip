// SPDX-License-Identifier: AGPL-3.0-only
// Kâtip policy gateway (LLD-03): the only path from Kâtip to LLM providers.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, Errors, createLogger, type Logger } from '@katip/shared';
import { ToolCallLog } from './tool-calls.js';
import {
  PlaceholderMap,
  conversationTokens,
  StreamingUnmasker,
  maskChatRequest,
  unmaskText,
  type ChatMessage,
  type ExtraDetector,
  type PiiPolicy,
} from '@katip/pii';
import {
  DEFAULT_CATALOG,
  DEFAULT_RULES,
  RouteDeniedError,
  chooseRoute,
  costMicroUsd,
  estimateTokens,
  visibleAliases,
  type Alias,
  type ModelEntry,
  type RouteDecision,
  type RouterRule,
  type TenantPolicy,
} from '@katip/policy-engine';
import {
  quotaClassOf,
  type QuotaStore,
  type Reservation,
  type Tenant,
  type TenantStore,
  type UsageSink,
  type User,
} from './stores.js';

export interface GatewayDeps {
  litellmBaseUrl: string;
  litellmApiKey: string;
  tenants: TenantStore;
  quota: QuotaStore;
  usage: UsageSink;
  catalog?: ModelEntry[];
  rules?: RouterRule[];
  /** Dynamic catalog/rules source (DB); takes precedence over static arrays. */
  catalogStore?: { getCatalog(): Promise<ModelEntry[]>; getRules(): Promise<RouterRule[]> };
  /**
   * Effective policy source (tenant + department override) with 30 s cache
   * and `policy.changed` invalidation (P1-10). When set, the resolved policy
   * overlays the tenant's base policy for every request.
   */
  policySource?: {
    effectivePolicy(tenant: Tenant, user: User): Promise<{ policy: TenantPolicy; pii: PiiPolicy }>;
  };
  /**
   * Extra PII detector (P1-11): Presidio NER for PERSON (TR + EN).
   * Applied to messages when set and PERSON masking is active for the tenant.
   * On failure the request follows the tenant's `pii.onDetectorFailure`.
   */
  piiDetector?: ExtraDetector;
  /** Secret behind conversation placeholders; without it they're numbered per request. */
  piiTokenKey?: string;
  /** Readiness beyond "the process is up", e.g. the governance DB is migrated. */
  ready?: () => Promise<boolean>;
  upstreamTimeoutMs?: number;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const ALIASES = new Set<Alias>(['auto', 'fast', 'best', 'tr-local']);
const DEFAULT_MAX_OUTPUT = 1024;

const ChatBodySchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.object({ role: z.string(), content: z.any() }).passthrough()).min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().int().positive().optional(),
  })
  .passthrough();

interface Ctx {
  tenant: Tenant;
  user: User;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function textOf(messages: ChatMessage[]): string {
  return messages
    .map((m) =>
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((p) => (typeof p.text === 'string' ? p.text : '')).join(' ')
          : '',
    )
    .join('\n');
}

export function buildGateway(deps: GatewayDeps): FastifyInstance {
  const log = deps.logger ?? createLogger('policy-gateway');
  const staticCatalog = deps.catalog ?? DEFAULT_CATALOG;
  const staticRules = deps.rules ?? DEFAULT_RULES;
  const getCatalog = async (): Promise<ModelEntry[]> =>
    deps.catalogStore ? await deps.catalogStore.getCatalog() : staticCatalog;
  const getRules = async (): Promise<RouterRule[]> =>
    deps.catalogStore ? await deps.catalogStore.getRules() : staticRules;
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.litellmBaseUrl.replace(/\/$/, '');

  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: false,
    bodyLimit: 20 * 1024 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      req.log.info({ code: err.code, status: err.status }, 'request rejected');
      return reply.code(err.status).send(err.toOpenAIError());
    }
    if (err instanceof z.ZodError) {
      const e = Errors.badRequest(
        `Invalid request: ${err.issues.map((i) => i.path.join('.')).join(', ')}`,
      );
      return reply.code(400).send(e.toOpenAIError());
    }
    const e = err as Error;
    req.log.error({ err: { message: e.message, name: e.name } }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { message: 'Internal error', type: 'api_error', code: 'internal' } });
  });

  async function authenticate(req: FastifyRequest): Promise<Ctx> {
    const key = bearer(req);
    if (!key) throw Errors.unauthorized();
    const tenant = await deps.tenants.findTenantByKey(key);
    if (!tenant) throw Errors.unauthorized();
    if (tenant.status !== 'active') throw Errors.policyDenied('company account is suspended');
    const email = header(req, 'x-user-email');
    if (!email) throw Errors.userNotProvisioned();
    const user = await deps.tenants.findUser(tenant.id, email);
    if (!user) throw Errors.userNotProvisioned();
    if (user.status !== 'active') throw Errors.userDisabled();
    // Effective policy = tenant policy + department override (P1-10), cached
    // 30 s and invalidated by `policy.changed` pub/sub.
    if (deps.policySource) {
      const eff = await deps.policySource.effectivePolicy(tenant, user);
      tenant.policy = eff.policy;
      tenant.pii = eff.pii;
    }
    return { tenant, user };
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const ready = deps.ready ? await deps.ready().catch(() => false) : true;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready' });
  });

  app.get('/v1/models', async (req) => {
    const { tenant } = await authenticate(req);
    const aliases = visibleAliases(tenant.policy, tenant.kvkkAddon);
    return {
      object: 'list',
      data: aliases.map((id) => ({ id, object: 'model', owned_by: 'katip' })),
    };
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    const ctx = await authenticate(req);
    const body = ChatBodySchema.parse(req.body);
    const messages = body.messages as ChatMessage[];
    const conversationId = header(req, 'x-conversation-id');

    // 1. Route
    const decision = await route(ctx, body.model, messages, req);

    // 2. Quota reservation (may downgrade premium → standard)
    let routed = decision;
    const estimate = estimateTokens(textOf(messages)) + (body.max_tokens ?? DEFAULT_MAX_OUTPUT);
    let q = await deps.quota.reserve(ctx.tenant, quotaClassOf(routed.class), estimate);
    if (q.decision === 'downgrade') {
      routed = chooseRoute(
        {
          alias: 'fast',
          inputTokens: estimateTokens(textOf(messages)),
          background: false,
          reasoningHint: false,
          premiumQuotaAvailable: false,
        },
        await getRules(),
        await getCatalog(),
        ctx.tenant.policy,
      );
      q = await deps.quota.reserve(ctx.tenant, quotaClassOf(routed.class), estimate);
    }
    if (!q.reservation) throw Errors.quotaExceeded(quotaClassOf(routed.class));
    const reservation = q.reservation;

    // 3. PII masking
    // An unfilled "{{...}}" header would put every chat in one conversation.
    const map = new PlaceholderMap(
      deps.piiTokenKey && conversationId && !conversationId.includes('{{')
        ? conversationTokens(deps.piiTokenKey, ctx.tenant.id, conversationId)
        : undefined,
    );
    let outbound: Record<string, unknown>;
    let piiDegraded = false;
    try {
      const r = await maskChatRequest(body, ctx.tenant.pii, map, deps.piiDetector);
      if (r.detectorFailed) {
        const reject = ctx.tenant.pii.onDetectorFailure === 'block';
        // Alert signal: monitoring (P1-43) alerts on this event. Ids only.
        req.log.error(
          {
            event: 'pii_detector_failed',
            tenant_id: ctx.tenant.id,
            user_id: ctx.user.id,
            action: reject ? 'blocked' : 'allowed',
          },
          'PII detector failed',
        );
        if (reject) throw Errors.piiUnavailable();
        piiDegraded = true;
      }
      if (r.blocked.length > 0) throw Errors.piiBlocked(r.blocked);
      if (r.dropped.length > 0) {
        req.log.warn(
          { event: 'request_fields_dropped', tenant_id: ctx.tenant.id, fields: r.dropped },
          'dropped fields not on the allow list',
        );
      }
      // Sent unscanned, by the product owner's decision for now (LLD-03 §5, P3-11).
      if (Object.keys(r.nonTextParts).length > 0) {
        req.log.info(
          {
            event: 'non_text_content_sent',
            tenant_id: ctx.tenant.id,
            user_id: ctx.user.id,
            parts: r.nonTextParts,
          },
          'images or files sent unscanned',
        );
      }
      outbound = r.body;
    } catch (e) {
      await deps.quota.settle(reservation, 0);
      throw e;
    }

    // 4. Upstream with fallback
    const { model, response, fallback } = await callUpstream(routed, {
      ...outbound,
      user: `${ctx.tenant.slug}:${ctx.user.id}`,
      metadata: {
        tenant: ctx.tenant.slug,
        user_id: ctx.user.id,
        conversation_id: conversationId,
        rule: routed.ruleId,
      },
      ...(body.stream ? { stream_options: { include_usage: true } } : {}),
    }).catch(async (e: unknown) => {
      await deps.quota.settle(reservation, 0);
      throw e;
    });

    reply.header('x-katip-model', model.id);
    reply.header('x-katip-rule', routed.ruleId);
    if (fallback) reply.header('x-katip-fallback', 'true');
    if (piiDegraded) reply.header('x-katip-pii-degraded', 'true');

    const toolCalls = new ToolCallLog();
    const finish = async (inputTokens: number, outputTokens: number) => {
      await deps.quota.settle(reservation, inputTokens + outputTokens);
      const tools = toolCalls.list();
      if (tools.length > 0) {
        // Names only. Users can add any MCP tool, and this shows which ones models call.
        req.log.info(
          {
            event: 'tool_calls_requested',
            tenant_id: ctx.tenant.id,
            user_id: ctx.user.id,
            conversation_id: conversationId,
            tools,
          },
          'model asked to call tools',
        );
      }
      await deps.usage.record({
        tenantId: ctx.tenant.id,
        userId: ctx.user.id,
        departmentId: ctx.user.departmentId,
        ts: new Date().toISOString(),
        alias: body.model,
        modelId: model.id,
        modelClass: model.class,
        ruleId: routed.ruleId,
        inputTokens,
        outputTokens,
        costMicroUsd: costMicroUsd(model, inputTokens, outputTokens),
        fallback,
        overage: reservation.overage,
        piiEntities: map.counts() as Record<string, number>,
        conversationId,
        source: 'chat',
        toolCalls: tools,
      });
      req.log.info(
        {
          tenant: ctx.tenant.slug,
          user: ctx.user.id,
          model: model.id,
          rule: routed.ruleId,
          inputTokens,
          outputTokens,
          fallback,
          pii: map.counts(),
        },
        'chat completed',
      );
    };

    if (!body.stream) {
      const json = (await response.json()) as {
        choices?: Array<{
          index?: number;
          message?: { content?: unknown; tool_calls?: unknown; function_call?: unknown };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      for (const c of json.choices ?? []) {
        if (c.message && typeof c.message.content === 'string')
          // Text for the user only. tool_calls stay masked: real values must not
          // reach tools, which may be any MCP server a user added (LLD-03 §5).
          c.message.content = unmaskText(c.message.content, map);
        if (c.message) toolCalls.add(c.index ?? 0, c.message);
      }
      json.model = model.id;
      await finish(json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0);
      return json;
    }

    await streamThrough(reply, response, map, model.id, finish, reservation, toolCalls);
    return reply;
  });

  async function route(
    ctx: Ctx,
    requested: string,
    messages: ChatMessage[],
    req: FastifyRequest,
  ): Promise<RouteDecision> {
    const inputTokens = estimateTokens(textOf(messages));
    try {
      if (ALIASES.has(requested as Alias)) {
        return chooseRoute(
          {
            alias: requested as Alias,
            inputTokens,
            background: header(req, 'x-task') === 'background',
            reasoningHint: header(req, 'x-reasoning') === 'high',
            premiumQuotaAvailable: await deps.quota.available(ctx.tenant, 'premium'),
          },
          await getRules(),
          await getCatalog(),
          ctx.tenant.policy,
        );
      }
      // Explicit model ids only when the tenant allows user model choice.
      const m = (await getCatalog()).find((c) => c.id === requested);
      const allowed =
        m &&
        m.enabled &&
        ctx.tenant.policy.allowUserModelChoice &&
        (ctx.tenant.policy.allowedModels.length === 0 ||
          ctx.tenant.policy.allowedModels.includes(m.id));
      if (!allowed)
        throw new RouteDeniedError(`model "${requested}" is not allowed for this company`);
      return { ruleId: 'explicit', class: m.class, candidates: [m] };
    } catch (e) {
      if (e instanceof RouteDeniedError) throw Errors.policyDenied(e.reason);
      throw e;
    }
  }

  async function callUpstream(
    decision: RouteDecision,
    payload: Record<string, unknown>,
  ): Promise<{ model: ModelEntry; response: Response; fallback: boolean }> {
    let index = 0;
    for (const model of decision.candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.upstreamTimeoutMs ?? 120_000);
      try {
        const res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.litellmApiKey}`,
          },
          body: JSON.stringify({ ...payload, model: model.litellmName }),
          signal: controller.signal,
        });
        if (res.ok) return { model, response: res, fallback: index > 0 };
        if (res.status < 500 && res.status !== 429) {
          const text = await res.text();
          log.warn({ model: model.id, status: res.status }, 'upstream rejected request');
          throw new AppError(
            res.status,
            'upstream_rejected',
            `Model provider rejected the request (${res.status})`,
            {
              upstream: text.slice(0, 200),
            },
          );
        }
        log.warn({ model: model.id, status: res.status }, 'upstream failed, trying fallback');
        await res.body?.cancel();
      } catch (e) {
        if (e instanceof AppError) throw e;
        log.warn({ model: model.id, err: (e as Error).name }, 'upstream error, trying fallback');
      } finally {
        clearTimeout(timer);
      }
      index++;
    }
    throw Errors.upstream();
  }

  return app as unknown as FastifyInstance;
}

/** Re-emits an upstream SSE stream, restoring PII placeholders and collecting usage. */
async function streamThrough(
  reply: FastifyReply,
  upstream: Response,
  map: PlaceholderMap,
  modelId: string,
  finish: (inTok: number, outTok: number) => Promise<void>,
  reservation: Reservation,
  toolCalls: ToolCallLog,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...Object.fromEntries(
      Object.entries(reply.getHeaders())
        .filter(([k]) => k.startsWith('x-katip-'))
        .map(([k, v]) => [k, String(v)]),
    ),
  });

  const unmaskers = new Map<number, StreamingUnmasker>();
  const unmaskerFor = (i: number) => {
    let u = unmaskers.get(i);
    if (!u) unmaskers.set(i, (u = new StreamingUnmasker(map)));
    return u;
  };
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let lastChunk: Record<string, unknown> | null = null;
  const write = (obj: unknown) => raw.write(`data: ${JSON.stringify(obj)}\n\n`);

  const flushAll = () => {
    for (const [index, u] of unmaskers) {
      const rest = u.flush();
      if (rest && lastChunk) {
        write({ ...lastChunk, choices: [{ index, delta: { content: rest } }] });
      }
    }
  };

  let reservationSettled = false;
  try {
    const reader = upstream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true;
            break;
          }
          let chunk: {
            choices?: Array<{
              index?: number;
              delta?: { content?: unknown; tool_calls?: unknown; function_call?: unknown };
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
            model?: string;
          };
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? 0,
              completion_tokens: chunk.usage.completion_tokens ?? 0,
            };
          }
          for (const c of chunk.choices ?? []) {
            // Only text: delta.tool_calls stay masked, as in the non-streaming case.
            if (c.delta && typeof c.delta.content === 'string') {
              c.delta.content = unmaskerFor(c.index ?? 0).push(c.delta.content);
            }
            if (c.delta) toolCalls.add(c.index ?? 0, c.delta);
          }
          chunk.model = modelId;
          lastChunk = { ...chunk, choices: [], usage: undefined };
          // Hold back the usage-only chunk until remaining text is flushed.
          if ((chunk.choices?.length ?? 0) === 0 && chunk.usage) {
            flushAll();
            write(chunk);
          } else {
            write(chunk);
          }
        }
      }
    }
    flushAll();
    raw.write('data: [DONE]\n\n');
    await finish(usage.prompt_tokens, usage.completion_tokens);
    reservationSettled = true;
  } finally {
    if (!reservationSettled) {
      // Stream broke mid-way: settle with what we know (at least the prompt estimate stays charged).
      await finish(usage.prompt_tokens, usage.completion_tokens).catch(() => undefined);
      void reservation;
    }
    raw.end();
  }
}
