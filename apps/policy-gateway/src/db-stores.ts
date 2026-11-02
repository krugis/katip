// SPDX-License-Identifier: AGPL-3.0-only
// Postgres + Valkey implementations of the gateway store interfaces (P1-02).
// Tenants/users/policies come from the governance DB; key lookups are cached
// in Valkey for 60 s (LLD-03 §2 step 1-2). The gateway connects as katip_gateway, which
// RLS binds: tenant data is only reachable inside withTenant. Only the key lookup runs
// without a tenant, as that's how the tenant is found (LLD-05 §1).
import { drizzle } from 'drizzle-orm/postgres-js';
import { desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import postgres from 'postgres';
import { keyPrefix, verifyKey, POLICY_CHANGED_CHANNEL, type Logger } from '@katip/shared';
import {
  DEFAULT_POLICY,
  type ModelEntry,
  type QuotaDecision,
  type RouterRule,
  type TenantPolicy,
} from '@katip/policy-engine';
import type { PiiPolicy } from '@katip/pii';
import * as schema from '@katip/db';
import {
  MemoryQuotaStore,
  MemoryUsageSink,
  type QuotaClass,
  type QuotaStore,
  type Reservation,
  type Tenant,
  type TenantStore,
  type UsageEvent,
  type UsageSink,
  type User,
} from './stores.js';

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Runs `fn` with this tenant as the RLS context, for that transaction only. */
function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

interface TenantRow {
  id: string;
  slug: string;
  status: string;
  kvkkAddon: boolean;
  policy: unknown;
  pii: unknown;
  stdLimit: number;
  premLimit: number;
}

interface UserRow {
  id: string;
  tenantId: string;
  email: string;
  status: string;
  departmentId: string | null;
}

const json = (v: unknown, fallback: unknown): unknown => {
  if (v === null || v === undefined) return fallback;
  return v;
};

/**
 * Caches key → tenant resolution in Valkey for 60 s. A revoked or rotated key
 * stops working at most 60 s later; suspending a tenant is checked live.
 */
export class ValkeyKeyCache {
  private readonly prefix = 'gw:auth:';

  constructor(
    private readonly redis: Redis | null,
    private readonly ttlSeconds = 60,
  ) {}

  async get(key: string): Promise<Tenant | null | undefined> {
    if (!this.redis) return undefined;
    const raw = await this.redis.get(this.prefix + key);
    if (raw === null) return undefined;
    return raw === '' ? null : (JSON.parse(raw) as Tenant);
  }

  async set(key: string, tenant: Tenant | null): Promise<void> {
    if (!this.redis) return;
    await this.redis.set(
      this.prefix + key,
      tenant ? JSON.stringify(tenant) : '',
      'EX',
      this.ttlSeconds,
    );
  }
}

function tenantFromRow(r: TenantRow): Tenant {
  return {
    id: r.id,
    slug: r.slug,
    status: r.status === 'suspended' ? 'suspended' : 'active',
    policy: { ...DEFAULT_POLICY, ...(r.policy as Partial<TenantPolicy>) },
    pii: (r.pii as PiiPolicy | null) ?? { mode: 'mask' },
    kvkkAddon: r.kvkkAddon,
    limits: { standard: Number(r.stdLimit), premium: Number(r.premLimit) },
  };
}

function userFromRow(r: UserRow): User {
  return {
    id: r.id,
    tenantId: r.tenantId,
    email: r.email,
    status: r.status === 'disabled' ? 'disabled' : 'active',
    departmentId: r.departmentId ?? undefined,
  };
}

/** Postgres-backed TenantStore: gateway_keys (argon2id) → tenants → users. */
export class DbTenantStore implements TenantStore {
  private readonly db;
  private readonly cache: ValkeyKeyCache;
  private readonly now: () => Date;

  constructor(databaseUrl: string, redis: Redis | null, opts: { now?: () => Date } = {}) {
    this.db = drizzle(postgres(databaseUrl, { max: 5, prepare: false }), { schema });
    this.cache = new ValkeyKeyCache(redis);
    this.now = opts.now ?? (() => new Date());
  }

  async close(): Promise<void> {
    await this.db.$client.end();
  }

  async findTenantByKey(apiKey: string): Promise<Tenant | null> {
    const prefix = keyPrefix(apiKey);
    if (!prefix) return null; // not our key format at all

    const cached = await this.cache.get(apiKey);
    if (cached !== undefined) return cached;

    const rows = await this.db
      .select({
        keyHash: schema.gatewayKeys.keyHash,
        expiresAt: schema.gatewayKeys.expiresAt,
        revokedAt: schema.gatewayKeys.revokedAt,
        type: schema.gatewayKeys.type,
        tenantId: schema.gatewayKeys.tenantId,
        slug: schema.tenants.slug,
        status: schema.tenants.status,
        kvkkAddon: schema.tenants.kvkkAddon,
      })
      .from(schema.gatewayKeys)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.gatewayKeys.tenantId))
      .where(eq(schema.gatewayKeys.prefix, prefix));

    const now = this.now();
    let resolved: Tenant | null = null;
    for (const r of rows) {
      if (r.revokedAt !== null) continue;
      if (r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime()) continue;
      if (!(await verifyKey(apiKey, r.keyHash))) continue;
      // Tenant data only after the key checks out, inside that tenant's context.
      const { policy, limits } = await withTenant(this.db, r.tenantId, async (tx) => ({
        policy: (
          await tx
            .select({ policy: schema.tenantPolicies.policy })
            .from(schema.tenantPolicies)
            .where(eq(schema.tenantPolicies.tenantId, r.tenantId))
        )[0]?.policy,
        limits: (
          await tx
            .select({
              std: schema.tenantLimits.stdTokens,
              prem: schema.tenantLimits.premTokens,
            })
            .from(schema.tenantLimits)
            .where(eq(schema.tenantLimits.tenantId, r.tenantId))
            .orderBy(desc(schema.tenantLimits.month))
            .limit(1)
        )[0],
      }));
      resolved = tenantFromRow({
        id: r.tenantId,
        slug: r.slug,
        status: r.status,
        kvkkAddon: r.kvkkAddon,
        policy: json(policy, {}),
        pii: piiOf(policy),
        stdLimit: limits?.std ?? 0,
        premLimit: limits?.prem ?? 0,
      });
      break;
    }
    await this.cache.set(apiKey, resolved);
    return resolved;
  }

  async findUser(tenantId: string, email: string): Promise<User | null> {
    const rows = await withTenant(this.db, tenantId, (tx) =>
      tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          status: schema.users.status,
          departmentId: schema.users.departmentId,
          tenantId: schema.users.tenantId,
        })
        .from(schema.users)
        .where(sql`${schema.users.tenantId} = ${tenantId} and ${schema.users.email} = ${email}`),
    );
    const r = rows[0];
    return r ? userFromRow(r) : null;
  }
}

type StoredPii = Partial<PiiPolicy>;

function piiOf(policy: unknown): PiiPolicy {
  const p = policy as { pii?: StoredPii } | null;
  return {
    mode: p?.pii?.mode ?? 'mask',
    entities: p?.pii?.entities,
    ...(p?.pii?.onDetectorFailure === 'block' ? { onDetectorFailure: 'block' as const } : {}),
  };
}

/** PII: departments may only tighten (mask→block, allow→block), never loosen. */
export function effectivePii(tenantPolicy: unknown, overridePii?: StoredPii): PiiPolicy {
  const basePii = piiOf(tenantPolicy);
  const pii: PiiPolicy =
    overridePii?.mode === 'block' || (overridePii?.mode === 'mask' && basePii.mode === 'off')
      ? { mode: overridePii.mode, entities: overridePii.entities }
      : { mode: basePii.mode, entities: basePii.entities };
  return basePii.onDetectorFailure === 'block' || overridePii?.onDetectorFailure === 'block'
    ? { ...pii, onDetectorFailure: 'block' }
    : pii;
}

export { MemoryQuotaStore, MemoryUsageSink };

/**
 * Model catalog + router rules from the governance DB (P1-04), with a TTL
 * cache so the gateway picks up catalog edits without a restart.
 */
export class DbCatalogStore {
  private readonly db;
  private readonly ttlMs: number;
  private loadedAt = 0;
  private catalog: ModelEntry[] = [];
  private rules: RouterRule[] = [];

  constructor(databaseUrl: string, ttlMs = 30_000) {
    this.db = drizzle(postgres(databaseUrl, { max: 1, prepare: false }), { schema });
    this.ttlMs = ttlMs;
  }

  async close(): Promise<void> {
    await this.db.$client.end();
  }

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.loadedAt < this.ttlMs && this.loadedAt > 0) return;
    const models = await this.db.select().from(schema.modelCatalog);
    this.catalog = models.map((m) => ({
      id: m.id,
      litellmName: m.litellmName,
      displayName: m.displayName,
      class: m.class as ModelEntry['class'],
      region: m.region as ModelEntry['region'],
      dataPolicy: m.dataPolicy as ModelEntry['dataPolicy'],
      priceInMicroPerM: Number(m.priceInUsdMicroPerM),
      priceOutMicroPerM: Number(m.priceOutUsdMicroPerM),
      enabled: m.enabled,
    }));
    const rules = await this.db
      .select()
      .from(schema.routerRules)
      .where(eq(schema.routerRules.enabled, true));
    this.rules = rules
      .map((r) => ({
        id: r.id,
        priority: r.priority,
        when: r.condition as RouterRule['when'],
        models: (r.route as { models: string[] }).models,
        strict: (r.route as { strict?: boolean }).strict ?? false,
      }))
      .sort((a, b) => a.priority - b.priority);
    this.loadedAt = Date.now();
  }

  async getCatalog(): Promise<ModelEntry[]> {
    await this.refresh();
    return this.catalog;
  }

  async getRules(): Promise<RouterRule[]> {
    await this.refresh();
    return this.rules;
  }
}

// ---- Valkey quota counters (P1-09) ----
// Atomic Lua reserve/settle on pooled monthly counters (LLD-03 §2 step 7).
// Keys: quota:{tenantId}:{yyyymm}:{class}. The counter gets a 26 h TTL, armed
// on first write of the month, so abandoned months expire automatically.

const QUOTA_RESERVE_LUA = `
local limit = tonumber(ARGV[1])
local estimate = tonumber(ARGV[2])
local behaviour = ARGV[3]
local can_downgrade = ARGV[4] == '1'
local ttl = tonumber(ARGV[5])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local after = used + estimate
local write = function()
  if redis.call('EXISTS', KEYS[1]) == 1 then
    redis.call('SET', KEYS[1], after, 'KEEPTTL')
  else
    redis.call('SET', KEYS[1], after, 'EX', ttl)
  end
end
if after <= limit then
  write()
  return {'allow', tostring(used), tostring(after)}
end
if behaviour == 'overage' then
  write()
  return {'overage', tostring(used), tostring(after)}
end
if behaviour == 'downgrade' and can_downgrade then
  return {'downgrade', tostring(used), tostring(after)}
end
return {'block', tostring(used), tostring(after)}
`;

const QUOTA_SETTLE_LUA = `
local reserved = tonumber(ARGV[1])
local actual = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local next = used - reserved + actual
if next < 0 then next = 0 end
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('SET', KEYS[1], next, 'KEEPTTL')
else
  redis.call('SET', KEYS[1], next, 'EX', ttl)
end
return tostring(next)
`;

/**
 * Quota counters in Valkey, modified only by atomic Lua scripts. The decision
 * logic (allow/overage/downgrade/block) lives in the script so check+increment
 * cannot race between concurrent gateway requests.
 */
export class ValkeyQuotaStore implements QuotaStore {
  constructor(
    private readonly redis: Redis,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlSeconds = 26 * 60 * 60,
  ) {}

  private monthOf(month?: string): string {
    if (month) return month;
    const d = this.now();
    return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private key(tenantId: string, cls: QuotaClass, month?: string): string {
    return `quota:${tenantId}:${this.monthOf(month)}:${cls}`;
  }

  /** Runs a Lua script and normalizes the reply to string[]. */
  private async evalLua(script: string, keys: string[], args: string[]): Promise<string[]> {
    const r = await this.redis.eval(script, keys.length, ...keys, ...args);
    return (Array.isArray(r) ? r : [r]).map(String);
  }

  async available(tenant: Tenant, cls: QuotaClass): Promise<boolean> {
    const used = await this.redis.get(this.key(tenant.id, cls));
    return (used ? Number(used) : 0) < tenant.limits[cls];
  }

  async reserve(
    tenant: Tenant,
    cls: QuotaClass,
    estimate: number,
  ): Promise<{ decision: QuotaDecision; reservation?: Reservation }> {
    const k = this.key(tenant.id, cls);
    const r = await this.evalLua(
      QUOTA_RESERVE_LUA,
      [k],
      [
        String(tenant.limits[cls]),
        String(estimate),
        tenant.policy.atQuotaLimit,
        cls === 'premium' ? '1' : '0',
        String(this.ttlSeconds),
      ],
    );
    const decision = r[0] as QuotaDecision;
    if (decision === 'allow' || decision === 'overage') {
      return {
        decision,
        reservation: {
          tenantId: tenant.id,
          cls,
          amount: estimate,
          overage: decision === 'overage',
          month: this.monthOf(),
        },
      };
    }
    return { decision };
  }

  async settle(r: Reservation, actual: number): Promise<void> {
    await this.evalLua(
      QUOTA_SETTLE_LUA,
      [this.key(r.tenantId, r.cls, r.month)],
      [String(r.amount), String(actual), String(this.ttlSeconds)],
    );
  }
}

// ---- usage_events writer + Valkey outbox (P1-14) ----
// LLD-03 §2 step 11: write usage_events directly; if Postgres is down, park
// the event in a Valkey list and drain it in the background, so no event is
// lost. Every event carries a client-side uuid (ON CONFLICT DO NOTHING) so a
// replay after a partial failure can never double-count.

/** True when the insert failed without a server-side SQL verdict (network/auth). */
const isConnectionError = (err: unknown): boolean => {
  // drizzle wraps driver errors; the postgres.js error is in `cause`
  let e = err as { code?: string; cause?: unknown };
  for (let i = 0; i < 3 && e && !e.code; i++) e = e.cause as { code?: string; cause?: unknown };
  const c = e?.code ?? '';
  // connection-level codes (ECONNREFUSED, ENOTFOUND, ETIMEDOUT…) are no SQLSTATE;
  // server rejections always carry a 5-char alphanumeric SQLSTATE (e.g. 22P02).
  return !/^[0-9A-Z]{5}$/.test(c);
};

export class DbUsageSink implements UsageSink {
  private readonly db;
  private readonly outbox: Redis | null;
  private readonly outboxKey = 'gw:usage:outbox';
  private readonly log: Logger | undefined;
  private draining = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    databaseUrl: string,
    opts: { redis?: Redis | null; logger?: Logger; drainIntervalMs?: number } = {},
  ) {
    this.db = drizzle(postgres(databaseUrl, { max: 2, prepare: false }), { schema });
    this.outbox = opts.redis ?? null;
    this.log = opts.logger;
    if (this.outbox) {
      const ms = opts.drainIntervalMs ?? 5_000;
      if (ms > 0) {
        this.timer = setInterval(() => void this.drainOutbox(), ms);
        this.timer.unref();
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    // Final drain attempt: allowed to run because stopped only guards the timer loop.
    await this.drainOutbox().catch(() => undefined);
    this.stopped = true;
    await this.db.$client.end();
  }

  async record(e: UsageEvent): Promise<void> {
    // One uuid per event: if the insert landed but the ACK was lost, the
    // outbox replay hits the same primary key and ON CONFLICT DO NOTHING
    // keeps it idempotent.
    const id = randomUUID();
    try {
      await this.insert(e, id);
    } catch (err) {
      if (!this.outbox) throw err;
      await this.outbox.rpush(this.outboxKey, JSON.stringify({ ...e, id }));
      this.log?.warn(
        { err: String(err), tenant: e.tenantId },
        'usage_events write failed; parked the event in the Valkey outbox',
      );
    }
  }

  /** Moves outboxed events back into Postgres; stops at the first failure. */
  async drainOutbox(): Promise<number> {
    if (!this.outbox || this.draining || this.stopped) return 0;
    this.draining = true;
    let moved = 0;
    try {
      for (let i = 0; i < 100; i++) {
        const raw = await this.outbox.lpop(this.outboxKey);
        if (raw === null) break;
        try {
          const ev = JSON.parse(raw) as UsageEvent & { id: string };
          await this.insert(ev, ev.id);
          moved++;
        } catch (err) {
          if (isConnectionError(err)) {
            // Postgres still down: keep the event at the head, retry next tick.
            await this.outbox.lpush(this.outboxKey, raw);
            this.log?.warn({ err: String(err) }, 'outbox drain failed; will retry');
            break;
          }
          // The server rejected this row (e.g. FK violation): park it on the
          // dead-letter list so one bad event cannot block the whole outbox.
          await this.outbox.rpush('gw:usage:dead', raw);
          this.log?.error(
            { err: String(err) },
            'outbox event rejected by Postgres; moved to gw:usage:dead',
          );
        }
      }
    } finally {
      this.draining = false;
    }
    return moved;
  }

  /** Events that can never be inserted (e.g. FK violations after user deletion). */
  async deadLetterCount(): Promise<number> {
    if (!this.outbox) return 0;
    return (await this.outbox.llen('gw:usage:dead')) ?? 0;
  }

  private async insert(e: UsageEvent, id: string): Promise<void> {
    await withTenant(this.db, e.tenantId, (tx) =>
      tx
        .insert(schema.usageEvents)
        .values({
          id,
          tenantId: e.tenantId,
          userId: e.userId,
          departmentId: e.departmentId ?? null,
          ts: new Date(e.ts),
          alias: e.alias,
          modelId: e.modelId,
          class: e.modelClass,
          inputTokens: e.inputTokens,
          outputTokens: e.outputTokens,
          costUsdMicro: e.costMicroUsd,
          priceUsdMicro: e.costMicroUsd, // list price = cost until pricing lands (P1-36)
          conversationId: e.conversationId ?? null,
          source: e.source,
          fallback: e.fallback,
          overage: e.overage,
          requestId: null,
        })
        .onConflictDoNothing(),
    );
  }
}

// ---- effective policy: tenant + department override (P1-10) ----
// LLD-03 §2 step 3: merge the tenant policy with the user's department
// override, cache the result for 30 s, and invalidate on `policy.changed`
// pub/sub so console edits apply immediately (30 s worst case).

export interface EffectivePolicy {
  policy: TenantPolicy;
  pii: PiiPolicy;
}

const POLICY_TTL_SECONDS = 30;

export class DbPolicySource {
  private readonly db;
  private readonly redis: Redis | null;
  private readonly log?: Logger;
  /** Subscriber connection; null when Valkey is absent (cache disabled). */
  private subscriber: Redis | null = null;
  /** Bumped by pub/sub; compared against the stamp inside cached entries. */
  private generation = new Map<string, number>();
  /** Bumped by '*' notifications so entries of unseen tenants also invalidate. */
  private allGeneration = 0;

  constructor(databaseUrl: string, redis: Redis | null, opts: { logger?: Logger } = {}) {
    this.db = drizzle(postgres(databaseUrl, { max: 2, prepare: false }), { schema });
    this.redis = redis;
    this.log = opts.logger;
  }

  /** Starts listening for policy.changed notifications. Idempotent. */
  async start(): Promise<void> {
    if (!this.redis || this.subscriber) return;
    // A dedicated connection: once SUBSCRIBEd, a connection can only run
    // subscribe/ping. duplicate() starts connecting on its own (ioredis
    // inherits lazyConnect: false), so we only wait for readiness.
    const sub = this.redis.duplicate();
    if (sub.status !== 'ready' && sub.status !== 'connecting' && sub.status !== 'connect') {
      await sub.connect();
    } else {
      await new Promise<void>((resolve) => {
        if (sub.status === 'ready') return resolve();
        const onReady = (): void => {
          sub.removeListener('ready', onReady);
          resolve();
        };
        sub.on('ready', onReady);
      });
    }
    await sub.subscribe(POLICY_CHANGED_CHANNEL);
    sub.on('message', (_channel: string, message: string) => {
      // message = tenant id, or '*' for all tenants. Bump (never reset to 0)
      // so cached entries with the old stamp stop matching.
      if (message === '*') {
        for (const t of this.generation.keys()) this.generation.set(t, this.generation.get(t)! + 1);
        this.allGeneration++;
      } else {
        this.generation.set(message, (this.generation.get(message) ?? 0) + 1);
      }
      this.log?.info({ tenant: message }, 'policy.changed: effective-policy cache invalidated');
    });
    this.subscriber = sub;
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => undefined);
      this.subscriber = null;
    }
    await this.db.$client.end();
  }

  private key(tenantId: string, userId: string): string {
    return `gw:policy:${tenantId}:${userId}`;
  }

  /** Current generation stamp for a tenant (bumped by invalidation). */
  private stamp(tenantId: string): number {
    return (this.generation.get(tenantId) ?? 0) + this.allGeneration;
  }

  async effectivePolicy(tenant: Tenant, user: User): Promise<EffectivePolicy> {
    const k = this.key(tenant.id, user.id);
    const stamp = this.stamp(tenant.id);
    if (this.redis) {
      const raw = await this.redis.get(k);
      if (raw !== null) {
        const cached = JSON.parse(raw) as EffectivePolicy & { stamp?: number };
        if (cached.stamp === stamp) {
          return { policy: cached.policy, pii: cached.pii };
        }
      }
    }
    const loaded = await this.load(tenant, user);
    if (this.redis) {
      await this.redis.set(k, JSON.stringify({ ...loaded, stamp }), 'EX', POLICY_TTL_SECONDS);
    }
    return loaded;
  }

  private async load(tenant: Tenant, user: User): Promise<EffectivePolicy> {
    const rows = await withTenant(this.db, tenant.id, (tx) =>
      tx
        .select({
          policy: schema.tenantPolicies.policy,
          override: schema.departments.policyOverride,
        })
        .from(schema.tenantPolicies)
        .leftJoin(
          schema.departments,
          user.departmentId
            ? sql`${schema.departments.id} = ${user.departmentId} and ${schema.departments.tenantId} = ${tenant.id}`
            : sql`false`,
        )
        .where(eq(schema.tenantPolicies.tenantId, tenant.id)),
    );
    const row = rows[0];
    const base = { ...DEFAULT_POLICY, ...((row?.policy as Partial<TenantPolicy>) ?? {}) };
    const rawOverride = (row?.override ?? {}) as Partial<TenantPolicy> & { pii?: StoredPii };
    const { pii: overridePii, ...override } = rawOverride;
    const policy = { ...base, ...override };
    return { policy, pii: effectivePii(row?.policy, overridePii) };
  }
}
