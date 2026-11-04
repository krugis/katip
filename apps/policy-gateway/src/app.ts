// SPDX-License-Identifier: AGPL-3.0-only
// Kâtip policy gateway (LLD-03): the only path from Kâtip to LLM providers.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, Errors, createLogger, type Logger } from '@katip/shared';
import { trace, withSpan, type Tracer } from '@katip/shared/tracing';
import { GatewayMetrics, UNKNOWN } from './metrics.js';
import { ToolCallLog } from './tool-calls.js';
import {
  PlaceholderMap,
  conversationTokens,
  embeddingPiiPolicy,
  StreamingUnmasker,
  maskChatRequest,
  maskEmbeddingRequest,
  unmaskText,
  type ChatMessage,
  type ExtraDetector,
  type PiiPolicy,
} from '@katip/pii';
import {
  DEFAULT_CATALOG,
  DEFAULT_RULES,
  NoEmbeddingModelError,
  RouteDeniedError,
  chooseEmbeddingRoute,
  chooseRoute,
  costMicroUsd,
  estimateTokens,
  reachesOnlySelfHosted,
  visibleAliases,
  type Alias,
  type ModelEntry,
  type RouteDecision,
  type RouterRule,
  type TenantPolicy,
} from '@katip/policy-engine';
import {
  NO_PERSON,
  quotaClassOf,
  type QuotaStore,
  type Reservation,
  type Tenant,
  type TenantStore,
  type UsageEvent,
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
  metrics?: GatewayMetrics;
  /** Without a tracing provider, the default does nothing. */
  tracer?: Tracer;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/**
 * Runs `onSilence` if nothing arrives for this long. The timeout on a call only covers its
 * headers, so without this a provider going quiet part-way would hang the reply for good.
 */
function watchForSilence(ms: number, onSilence: () => void) {
  let timer: NodeJS.Timeout;
  const stop = () => clearTimeout(timer);
  const touch = () => {
    stop();
    timer = setTimeout(onSilence, ms);
  };
  touch();
  return { touch, stop };
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

/** Text only. Token ids can't be checked for personal data, so they never reach a provider. */
const EmbeddingBodySchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(z.string()).min(1).max(2048)]),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
  })
  .passthrough();

const METERED_ROUTES = new Set(['/v1/chat/completions', '/v1/embeddings']);

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
  const metrics = deps.metrics ?? new GatewayMetrics();
  const tracer = deps.tracer ?? trace.getTracer('policy-gateway');
  /** Filled in as a request learns them. Never what a caller typed. */
  const requestLabels = new WeakMap<
    FastifyRequest,
    { tenant: string; alias: string; model: string }
  >();
  const countRequest = (req: FastifyRequest, status: number) => {
    const { tenant, alias, model } = requestLabels.get(req) ?? {
      tenant: UNKNOWN,
      alias: UNKNOWN,
      model: UNKNOWN,
    };
    metrics.requests.inc({ tenant, alias, model, status: String(status) });
  };

  const app = Fastify({
    loggerInstance: log,
    disableRequestLogging: false,
    bodyLimit: 20 * 1024 * 1024,
  });

  // A streamed reply comes here too, when it has ended.
  app.addHook('onResponse', async (req, reply) => {
    if (METERED_ROUTES.has(req.routeOptions.url ?? '')) countRequest(req, reply.statusCode);
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

  /** A service key has no person behind it, so only routes that allow it accept one. */
  async function authenticate(req: FastifyRequest, { allowService = false } = {}): Promise<Ctx> {
    const key = bearer(req);
    if (!key) throw Errors.unauthorized();
    const tenant = await deps.tenants.findTenantByKey(key);
    if (!tenant) throw Errors.unauthorized();
    if (tenant.status !== 'active') throw Errors.policyDenied('company account is suspended');
    let user: User | null;
    if (tenant.serviceKey) {
      if (!allowService) throw Errors.policyDenied('this key can only create embeddings');
      user = { id: NO_PERSON, tenantId: tenant.id, email: '', status: 'active' };
    } else {
      const email = header(req, 'x-user-email');
      if (!email) throw Errors.userNotProvisioned();
      user = await deps.tenants.findUser(tenant.id, email);
      if (!user) throw Errors.userNotProvisioned();
      if (user.status !== 'active') throw Errors.userDisabled();
    }
    // Effective policy = tenant policy + department override (P1-10), cached
    // 30 s and invalidated by `policy.changed` pub/sub.
    if (deps.policySource) {
      const eff = await deps.policySource.effectivePolicy(tenant, user);
      tenant.policy = eff.policy;
      tenant.pii = eff.pii;
    }
    return { tenant, user };
  }

  /** Applies the policy to a masking result. Throws to refuse; true if names went unchecked. */
  function judgeMasking(
    req: FastifyRequest,
    ctx: Ctx,
    r: { detectorFailed: boolean; blocked: string[]; dropped: string[] },
  ): boolean {
    if (r.detectorFailed) {
      const reject = ctx.tenant.pii.onDetectorFailure === 'block';
      metrics.piiDetectorFailures.inc({
        tenant: ctx.tenant.slug,
        action: reject ? 'blocked' : 'allowed',
      });
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
    }
    if (r.blocked.length > 0) throw Errors.piiBlocked(r.blocked);
    if (r.dropped.length > 0) {
      req.log.warn(
        { event: 'request_fields_dropped', tenant_id: ctx.tenant.id, fields: r.dropped },
        'dropped fields not on the allow list',
      );
    }
    return r.detectorFailed;
  }

  /** Everything that follows a model's answer: quota, metrics and the usage row. */
  async function settleAndRecord(
    m: Pick<UsageEvent, 'alias' | 'fallback' | 'conversationId' | 'source' | 'toolCalls'> & {
      ctx: Ctx;
      model: ModelEntry;
      ruleId: string;
      reservation: Reservation;
      map: PlaceholderMap;
    },
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    const { ctx, model, ruleId, reservation, map, ...event } = m;
    await withSpan(tracer, 'settle', () =>
      deps.quota.settle(reservation, inputTokens + outputTokens),
    );
    const tokenLabels = { tenant: ctx.tenant.slug, class: model.class };
    metrics.tokens.inc({ ...tokenLabels, dir: 'input' }, inputTokens);
    metrics.tokens.inc({ ...tokenLabels, dir: 'output' }, outputTokens);
    const cost = costMicroUsd(model, inputTokens, outputTokens);
    metrics.cost.inc(tokenLabels, cost);
    for (const [type, n] of Object.entries(map.counts() as Record<string, number>)) {
      metrics.piiEntities.inc({ type }, n);
    }
    await deps.usage.record({
      ...event,
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      departmentId: ctx.user.departmentId,
      ts: new Date().toISOString(),
      modelId: model.id,
      modelClass: model.class,
      ruleId,
      inputTokens,
      outputTokens,
      costMicroUsd: cost,
      overage: reservation.overage,
      piiEntities: map.counts() as Record<string, number>,
    });
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

  app.post('/v1/chat/completions', async (req, reply) =>
    withSpan(tracer, 'gateway.chat', async (root) => {
      const started = performance.now();
      const ctx = await withSpan(tracer, 'auth', () => authenticate(req));
      root.setAttribute('tenant.slug', ctx.tenant.slug);
      const labels = { tenant: ctx.tenant.slug, alias: UNKNOWN, model: UNKNOWN };
      requestLabels.set(req, labels);
      const body = ChatBodySchema.parse(req.body);
      labels.alias = ALIASES.has(body.model as Alias) ? body.model : 'explicit';
      root.setAttribute('model.alias', labels.alias);
      const messages = body.messages as ChatMessage[];
      const conversationId = header(req, 'x-conversation-id');

      // 1. Route
      const decision = await withSpan(tracer, 'route', () => route(ctx, body.model, messages, req));

      // 2. Quota reservation (may downgrade premium → standard)
      let routed = decision;
      const estimate = estimateTokens(textOf(messages)) + (body.max_tokens ?? DEFAULT_MAX_OUTPUT);
      const reservation = await withSpan(tracer, 'policy', async () => {
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
        if (!q.reservation) {
          metrics.quotaDenials.inc({ tenant: ctx.tenant.slug, class: quotaClassOf(routed.class) });
          throw Errors.quotaExceeded(quotaClassOf(routed.class));
        }
        return q.reservation;
      });
      root.setAttribute('quota.class', quotaClassOf(routed.class));

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
        const r = await withSpan(tracer, 'pii', async (span) => {
          const masked = await maskChatRequest(body, ctx.tenant.pii, map, deps.piiDetector);
          span.setAttribute(
            'pii.entities_count',
            Object.values(map.counts() as Record<string, number>).reduce((a, b) => a + b, 0),
          );
          return masked;
        });
        piiDegraded = judgeMasking(req, ctx, r);
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
      metrics.overhead.observe({ tenant: ctx.tenant.slug }, (performance.now() - started) / 1000);
      const { model, response, fallback, abort } = await withSpan(tracer, 'upstream', () =>
        callUpstream(ctx.tenant.slug, routed, '/chat/completions', {
          ...outbound,
          user: `${ctx.tenant.slug}:${ctx.user.id}`,
          metadata: {
            tenant: ctx.tenant.slug,
            user_id: ctx.user.id,
            conversation_id: conversationId,
            rule: routed.ruleId,
          },
          ...(body.stream ? { stream_options: { include_usage: true } } : {}),
        }),
      ).catch(async (e: unknown) => {
        await deps.quota.settle(reservation, 0);
        throw e;
      });
      labels.model = model.id;
      root.setAttribute('model.name', model.id);

      reply.header('x-katip-model', model.id);
      reply.header('x-katip-rule', routed.ruleId);
      if (fallback) reply.header('x-katip-fallback', 'true');
      if (piiDegraded) reply.header('x-katip-pii-degraded', 'true');

      const quiet = watchForSilence(deps.upstreamTimeoutMs ?? 120_000, () => {
        metrics.upstreamErrors.inc({ model: model.id });
        req.log.warn({ model: model.id }, 'upstream went quiet part-way');
        abort();
      });
      const toolCalls = new ToolCallLog();
      const finish = async (inputTokens: number, outputTokens: number) => {
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
        await settleAndRecord(
          {
            ctx,
            model,
            ruleId: routed.ruleId,
            reservation,
            map,
            alias: body.model,
            fallback,
            conversationId,
            source: 'chat',
            toolCalls: tools,
          },
          inputTokens,
          outputTokens,
        );
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
        const json = (await response
          .json()
          .catch(async () => {
            await deps.quota.settle(reservation, 0);
            throw Errors.upstream();
          })
          .finally(quiet.stop)) as {
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

      await streamThrough(reply, response, map, model.id, finish, reservation, toolCalls, quiet);
      return reply;
    }),
  );

  app.post('/v1/embeddings', async (req, reply) =>
    withSpan(tracer, 'gateway.embeddings', async (root) => {
      const started = performance.now();
      // The RAG API can't send a person's email, so it has a service key (LLD-03 §1).
      const ctx = await withSpan(tracer, 'auth', () => authenticate(req, { allowService: true }));
      root.setAttribute('tenant.slug', ctx.tenant.slug);
      const labels = { tenant: ctx.tenant.slug, alias: UNKNOWN, model: UNKNOWN };
      requestLabels.set(req, labels);
      const body = EmbeddingBodySchema.parse(req.body);
      labels.alias = ALIASES.has(body.model as Alias) ? body.model : 'explicit';
      root.setAttribute('model.alias', labels.alias);
      const inputs = typeof body.input === 'string' ? [body.input] : body.input;

      const routed = await withSpan(tracer, 'route', async () => {
        try {
          return chooseEmbeddingRoute(body.model, await getCatalog(), ctx.tenant.policy);
        } catch (e) {
          if (e instanceof NoEmbeddingModelError) {
            // An operator's signal: LibreChat shows people a generic error (LLD-03 §1.3).
            req.log.warn(
              {
                event: 'embedding_no_allowed_model',
                tenant_id: ctx.tenant.id,
                residency: e.residency,
              },
              'no embedding model this company may use',
            );
            throw Errors.embeddingUnavailable(e.residency);
          }
          if (e instanceof RouteDeniedError) throw Errors.policyDenied(e.reason);
          throw e;
        }
      });

      // Counted as standard tokens. There's no cheaper class to downgrade to.
      const cls = quotaClassOf(routed.class);
      const estimate = estimateTokens(inputs.join('\n'));
      const reservation = await withSpan(tracer, 'policy', async () => {
        const q = await deps.quota.reserve(ctx.tenant, cls, estimate);
        if (!q.reservation) {
          metrics.quotaDenials.inc({ tenant: ctx.tenant.slug, class: cls });
          throw Errors.quotaExceeded(cls);
        }
        return q.reservation;
      });
      root.setAttribute('quota.class', cls);

      // Numbered per request, whatever the conversation: nothing comes back to unmask, and
      // the provider shouldn't be able to link one person across a company's documents.
      const map = new PlaceholderMap();
      // Real text only where nothing leaves the operator's servers (LLD-03 §5).
      const selfHosted = reachesOnlySelfHosted(routed);
      const piiPolicy = embeddingPiiPolicy(ctx.tenant.pii, selfHosted);
      let outbound: Record<string, unknown>;
      let piiDegraded = false;
      try {
        const r = await withSpan(tracer, 'pii', async (span) => {
          const masked = await maskEmbeddingRequest(body, piiPolicy, map, deps.piiDetector);
          span.setAttribute('pii.self_hosted', selfHosted);
          span.setAttribute(
            'pii.entities_count',
            Object.values(map.counts() as Record<string, number>).reduce((a, b) => a + b, 0),
          );
          return masked;
        });
        piiDegraded = judgeMasking(req, ctx, r);
        outbound = r.body;
      } catch (e) {
        await deps.quota.settle(reservation, 0);
        throw e;
      }

      metrics.overhead.observe({ tenant: ctx.tenant.slug }, (performance.now() - started) / 1000);
      const conversationId = header(req, 'x-conversation-id');
      const { model, response, abort } = await withSpan(tracer, 'upstream', () =>
        callUpstream(ctx.tenant.slug, routed, '/embeddings', {
          ...outbound,
          user: `${ctx.tenant.slug}:${ctx.user.id}`,
          metadata: {
            tenant: ctx.tenant.slug,
            user_id: ctx.user.id,
            rule: routed.ruleId,
          },
        }),
      ).catch(async (e: unknown) => {
        await deps.quota.settle(reservation, 0);
        throw e;
      });
      labels.model = model.id;
      root.setAttribute('model.name', model.id);
      reply.header('x-katip-model', model.id);
      if (piiDegraded) reply.header('x-katip-pii-degraded', 'true');

      const quiet = watchForSilence(deps.upstreamTimeoutMs ?? 120_000, () => {
        metrics.upstreamErrors.inc({ model: model.id });
        req.log.warn({ model: model.id }, 'upstream went quiet part-way');
        abort();
      });
      const json = (await response
        .json()
        .catch(() => null)
        .finally(quiet.stop)) as {
        data?: unknown[];
        usage?: { prompt_tokens?: number; total_tokens?: number };
      } | null;
      // One vector per input, or the wrong text would be found under them.
      if (json?.data?.length !== inputs.length) {
        await deps.quota.settle(reservation, 0);
        throw Errors.upstream();
      }
      // Some providers report no usage. It must still count, so then the estimate does.
      const inputTokens = json.usage?.prompt_tokens || json.usage?.total_tokens || estimate;
      await settleAndRecord(
        {
          ctx,
          model,
          ruleId: routed.ruleId,
          reservation,
          map,
          alias: body.model,
          fallback: false,
          conversationId,
          source: 'embedding',
        },
        inputTokens,
        0,
      );
      req.log.info(
        {
          tenant: ctx.tenant.slug,
          user: ctx.user.id,
          model: model.id,
          inputs: inputs.length,
          inputTokens,
          selfHosted,
          pii: map.counts(),
        },
        'embeddings completed',
      );
      return {
        object: 'list',
        data: json.data,
        model: model.id,
        usage: { prompt_tokens: inputTokens, total_tokens: inputTokens },
      };
    }),
  );

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
    tenantSlug: string,
    decision: RouteDecision,
    path: '/chat/completions' | '/embeddings',
    payload: Record<string, unknown>,
  ): Promise<{ model: ModelEntry; response: Response; fallback: boolean; abort: () => void }> {
    let index = 0;
    for (const model of decision.candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.upstreamTimeoutMs ?? 120_000);
      const called = performance.now();
      try {
        const res = await doFetch(`${base}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${deps.litellmApiKey}`,
          },
          body: JSON.stringify({ ...payload, model: model.litellmName }),
          signal: controller.signal,
        });
        if (res.ok) {
          metrics.upstreamLatency.observe(
            { tenant: tenantSlug, model: model.id },
            (performance.now() - called) / 1000,
          );
          return { model, response: res, fallback: index > 0, abort: () => controller.abort() };
        }
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
        metrics.upstreamErrors.inc({ model: model.id });
        log.warn({ model: model.id, status: res.status }, 'upstream failed, trying fallback');
        await res.body?.cancel();
      } catch (e) {
        if (e instanceof AppError) throw e;
        metrics.upstreamErrors.inc({ model: model.id });
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
  quiet: { touch: () => void; stop: () => void },
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
      quiet.touch();
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
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
    // It's too late to try another model. Say so, and keep what the person already has.
    flushAll();
    write({
      error: {
        message: 'The model stopped responding. This answer may be incomplete.',
        type: 'api_error',
        code: 'upstream_stalled',
      },
    });
    raw.write('data: [DONE]\n\n');
  } finally {
    quiet.stop();
    if (!reservationSettled) {
      // Stream broke mid-way: settle with what we know (at least the prompt estimate stays charged).
      await finish(usage.prompt_tokens, usage.completion_tokens).catch(() => undefined);
      void reservation;
    }
    raw.end();
  }
}
