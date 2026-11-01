// SPDX-License-Identifier: AGPL-3.0-only
// Postgres + Valkey implementations of the gateway store interfaces (P1-02).
// Tenants/users/policies come from the governance DB; key lookups are cached
// in Valkey for 60 s (LLD-03 §2 step 1-2). RLS is bypassed here on purpose:
// the gateway resolves tenants itself before any user-context query.
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import postgres from 'postgres';
import { keyPrefix, verifyKey } from '@katip/shared';
import {
  DEFAULT_POLICY,
  type ModelEntry,
  type RouterRule,
  type TenantPolicy,
} from '@katip/policy-engine';
import type { PiiPolicy } from '@katip/pii';
import * as schema from '@katip/db';
import {
  MemoryQuotaStore,
  MemoryUsageSink,
  type Tenant,
  type TenantStore,
  type User,
} from './stores.js';

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
        policy: schema.tenantPolicies.policy,
        stdTokens: schema.tenantLimits.stdTokens,
        premTokens: schema.tenantLimits.premTokens,
      })
      .from(schema.gatewayKeys)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.gatewayKeys.tenantId))
      .leftJoin(
        schema.tenantPolicies,
        eq(schema.tenantPolicies.tenantId, schema.gatewayKeys.tenantId),
      )
      .leftJoin(schema.tenantLimits, eq(schema.tenantLimits.tenantId, schema.gatewayKeys.tenantId))
      .where(eq(schema.gatewayKeys.prefix, prefix));

    const now = this.now();
    let resolved: Tenant | null = null;
    for (const r of rows) {
      if (r.revokedAt !== null) continue;
      if (r.expiresAt !== null && r.expiresAt.getTime() <= now.getTime()) continue;
      if (!(await verifyKey(apiKey, r.keyHash))) continue;
      resolved = tenantFromRow({
        id: r.tenantId,
        slug: r.slug,
        status: r.status,
        kvkkAddon: r.kvkkAddon,
        policy: json(r.policy, {}),
        pii: piiOf(r.policy),
        stdLimit: r.stdTokens ?? 0,
        premLimit: r.premTokens ?? 0,
      });
      break;
    }
    await this.cache.set(apiKey, resolved);
    return resolved;
  }

  async findUser(tenantId: string, email: string): Promise<User | null> {
    const rows = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        status: schema.users.status,
        departmentId: schema.users.departmentId,
        tenantId: schema.users.tenantId,
      })
      .from(schema.users)
      .where(sql`${schema.users.tenantId} = ${tenantId} and ${schema.users.email} = ${email}`);
    const r = rows[0];
    return r ? userFromRow(r) : null;
  }
}

function piiOf(policy: unknown): PiiPolicy {
  const p = policy as {
    pii?: { mode?: PiiPolicy['mode']; entities?: PiiPolicy['entities'] };
  } | null;
  return { mode: p?.pii?.mode ?? 'mask', entities: p?.pii?.entities };
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
