// SPDX-License-Identifier: AGPL-3.0-only
// Kâtip policy gateway (LLD-03): the only path from Kâtip to LLM providers.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, Errors, createLogger, type Logger } from '@katip/shared';
import {
  PlaceholderMap,
  StreamingUnmasker,
  maskMessages,
  unmaskText,
  type ChatMessage,
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
  const catalog = deps.catalog ?? DEFAULT_CATALOG;
  const rules = deps.rules ?? DEFAULT_RULES;
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
    return { tenant, user };
  }

  app.get('/healthz', async () => ({ status: 'ok' }));

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
        rules,
        catalog,
        ctx.tenant.policy,
      );
      q = await deps.quota.reserve(ctx.tenant, quotaClassOf(routed.class), estimate);
    }
    if (!q.reservation) throw Errors.quotaExceeded(quotaClassOf(routed.class));
    const reservation = q.reservation;

    // 3. PII masking
    const map = new PlaceholderMap();
    let masked: ChatMessage[];
    try {
      const r = await maskMessages(messages, ctx.tenant.pii, map);
      if (r.blocked.length > 0) throw Errors.piiBlocked(r.blocked);
      masked = r.messages;
    } catch (e) {
      await deps.quota.settle(reservation, 0);
      throw e;
    }

    // 4. Upstream with fallback
    const { model, response, fallback } = await callUpstream(routed, {
      ...body,
      messages: masked,
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

    const finish = async (inputTokens: number, outputTokens: number) => {
      await deps.quota.settle(reservation, inputTokens + outputTokens);
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
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      for (const c of json.choices ?? []) {
        if (c.message && typeof c.message.content === 'string')
          c.message.content = unmaskText(c.message.content, map);
      }
      json.model = model.id;
      await finish(json.usage?.prompt_tokens ?? 0, json.usage?.completion_tokens ?? 0);
      return json;
    }

    await streamThrough(reply, response, map, model.id, finish, reservation);
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
          rules,
          catalog,
          ctx.tenant.policy,
        );
      }
      // Explicit model ids only when the tenant allows user model choice.
      const m = catalog.find((c) => c.id === requested);
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
            choices?: Array<{ index?: number; delta?: { content?: unknown } }>;
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
            if (c.delta && typeof c.delta.content === 'string') {
              c.delta.content = unmaskerFor(c.index ?? 0).push(c.delta.content);
            }
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
