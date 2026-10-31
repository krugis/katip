// SPDX-License-Identifier: AGPL-3.0-only
// Storage interfaces used by the gateway pipeline, with in-memory implementations.
// Postgres (tenants, users, usage) and Valkey (quota counters) implementations replace these
// in tracker tasks P1-02, P1-09, P1-14 and P1-17 without changing the pipeline.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { PiiPolicy } from '@katip/pii';
import {
  DEFAULT_POLICY,
  decideQuota,
  type ModelClass,
  type QuotaDecision,
  type TenantPolicy,
} from '@katip/policy-engine';

export interface Tenant {
  id: string;
  slug: string;
  status: 'active' | 'suspended';
  policy: TenantPolicy;
  pii: PiiPolicy;
  kvkkAddon: boolean;
  /** Pooled monthly token limits per quota class. */
  limits: { standard: number; premium: number };
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  status: 'active' | 'disabled';
  departmentId?: string | undefined;
}

export interface TenantStore {
  findTenantByKey(apiKey: string): Promise<Tenant | null>;
  findUser(tenantId: string, email: string): Promise<User | null>;
}

export type QuotaClass = 'standard' | 'premium';
export const quotaClassOf = (c: ModelClass): QuotaClass =>
  c === 'premium' ? 'premium' : 'standard';

export interface Reservation {
  tenantId: string;
  cls: QuotaClass;
  amount: number;
  overage: boolean;
}

export interface QuotaStore {
  available(tenant: Tenant, cls: QuotaClass): Promise<boolean>;
  /** Atomically decides and reserves. Returns the decision and, when allowed, a reservation. */
  reserve(
    tenant: Tenant,
    cls: QuotaClass,
    estimate: number,
  ): Promise<{ decision: QuotaDecision; reservation?: Reservation }>;
  /** Replaces the reserved amount with the actual amount (actual may be 0 on failure). */
  settle(r: Reservation, actual: number): Promise<void>;
}

export interface UsageEvent {
  tenantId: string;
  userId: string;
  departmentId?: string | undefined;
  ts: string;
  alias: string;
  modelId: string;
  modelClass: ModelClass;
  ruleId: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  fallback: boolean;
  overage: boolean;
  piiEntities: Record<string, number>;
  conversationId?: string | undefined;
  source: 'chat' | 'embedding';
}

export interface UsageSink {
  record(e: UsageEvent): Promise<void>;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** In-memory tenant store. Keys are stored as SHA-256 hashes (argon2id in the Postgres store). */
export class MemoryTenantStore implements TenantStore {
  private readonly byKeyHash = new Map<string, Tenant>();
  private readonly users = new Map<string, User>();

  addTenant(t: Tenant, apiKeys: string[] | { hashes: string[] }): void {
    const hashes = Array.isArray(apiKeys) ? apiKeys.map(sha256) : apiKeys.hashes;
    for (const h of hashes) this.byKeyHash.set(h, t);
  }

  addUser(u: User): void {
    this.users.set(`${u.tenantId}\u0000${u.email.toLowerCase()}`, u);
  }

  async findTenantByKey(apiKey: string): Promise<Tenant | null> {
    return this.byKeyHash.get(sha256(apiKey)) ?? null;
  }

  async findUser(tenantId: string, email: string): Promise<User | null> {
    return this.users.get(`${tenantId}\u0000${email.toLowerCase()}`) ?? null;
  }
}

/** In-memory pooled quota counters per tenant, month and class. Valkey + Lua in production. */
export class MemoryQuotaStore implements QuotaStore {
  private readonly used = new Map<string, number>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  private key(tenantId: string, cls: QuotaClass): string {
    const d = this.now();
    return `${tenantId}:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}:${cls}`;
  }

  usedOf(tenantId: string, cls: QuotaClass): number {
    return this.used.get(this.key(tenantId, cls)) ?? 0;
  }

  async available(tenant: Tenant, cls: QuotaClass): Promise<boolean> {
    return this.usedOf(tenant.id, cls) < tenant.limits[cls];
  }

  async reserve(tenant: Tenant, cls: QuotaClass, estimate: number) {
    const k = this.key(tenant.id, cls);
    const used = this.used.get(k) ?? 0;
    const decision = decideQuota(
      used,
      tenant.limits[cls],
      estimate,
      tenant.policy.atQuotaLimit,
      cls === 'premium',
    );
    if (decision === 'allow' || decision === 'overage') {
      this.used.set(k, used + estimate);
      return {
        decision,
        reservation: {
          tenantId: tenant.id,
          cls,
          amount: estimate,
          overage: decision === 'overage',
        },
      };
    }
    return { decision };
  }

  async settle(r: Reservation, actual: number): Promise<void> {
    const k = this.key(r.tenantId, r.cls);
    this.used.set(k, Math.max(0, (this.used.get(k) ?? 0) - r.amount + actual));
  }
}

export class MemoryUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];
  async record(e: UsageEvent): Promise<void> {
    this.events.push(e);
  }
}

// ---- dev tenants file (DEV ONLY) ----

const DevFileSchema = z.object({
  tenants: z.array(
    z.object({
      id: z.string(),
      slug: z.string().regex(/^[a-z0-9-]{3,32}$/),
      status: z.enum(['active', 'suspended']).default('active'),
      apiKeySha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
      kvkkAddon: z.boolean().default(false),
      limits: z.object({
        standard: z.number().int().nonnegative(),
        premium: z.number().int().nonnegative(),
      }),
      policy: z.record(z.unknown()).optional(),
      pii: z
        .object({
          mode: z.enum(['off', 'mask', 'block']),
          entities: z.record(z.enum(['off', 'mask', 'block'])).optional(),
        })
        .default({ mode: 'mask' }),
      users: z.array(
        z.object({
          id: z.string(),
          email: z.string().email(),
          status: z.enum(['active', 'disabled']).default('active'),
          departmentId: z.string().optional(),
        }),
      ),
    }),
  ),
});

export function loadDevTenants(path: string): MemoryTenantStore {
  const parsed = DevFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const store = new MemoryTenantStore();
  for (const t of parsed.tenants) {
    const tenant: Tenant = {
      id: t.id,
      slug: t.slug,
      status: t.status,
      kvkkAddon: t.kvkkAddon,
      limits: t.limits,
      policy: { ...DEFAULT_POLICY, ...(t.policy as Partial<TenantPolicy> | undefined) },
      pii: t.pii as PiiPolicy,
    };
    store.addTenant(tenant, { hashes: t.apiKeySha256 });
    for (const u of t.users) store.addUser({ ...u, tenantId: t.id });
  }
  return store;
}
