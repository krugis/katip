// SPDX-License-Identifier: AGPL-3.0-only
// P1-10 acceptance: effective policy = tenant policy + department override,
// cached ≤ 30 s; a `policy.changed` publish invalidates the cache so the
// change applies within 30 s (immediately when the gateway is subscribed).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ValkeyContainer } from '@testcontainers/valkey';
import { Redis } from 'ioredis';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@katip/db';
import { migrateWithClient, seed } from '@katip/db';
import {
  POLICY_CHANGED_CHANNEL,
  publishPolicyChanged,
  hashGatewayKey,
  createLogger,
} from '@katip/shared';
import { DbPolicySource } from '../src/db-stores.js';
import { buildGateway } from '../src/app.js';
import { buildMockApp } from '@katip/mock-llm';
import { MemoryQuotaStore, MemoryUsageSink } from '../src/stores.js';
import type { Tenant, User } from '../src/stores.js';

let pg: postgres.Sql;
let pgUri: string;
let db: PostgresJsDatabase<typeof schema>;
let pgContainer: Awaited<ReturnType<PostgreSqlContainer['start']>> | null = null;
let redis: Redis;
let valkeyContainer: Awaited<ReturnType<ValkeyContainer['start']>> | null = null;

let tenantId: string;
let userId: string;
let deptId: string;

const month = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

const tenant = (): Tenant => ({
  id: tenantId,
  slug: 'acme',
  status: 'active',
  policy: {
    aliases: { auto: true, fast: true, best: true, 'tr-local': false },
    allowUserModelChoice: false,
    allowedModels: [],
    atQuotaLimit: 'downgrade',
    residency: 'ANY_APPROVED',
  },
  pii: { mode: 'mask' },
  kvkkAddon: false,
  limits: { standard: 1_000, premium: 200 },
});

const user = (): User => ({
  id: userId,
  tenantId,
  email: 'ayse@acme.test',
  status: 'active',
  departmentId: deptId,
});

beforeAll(async () => {
  const pgc = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  pgContainer = pgc;
  pgUri = pgc.getConnectionUri();
  pg = postgres(pgUri, { max: 1 });
  await migrateWithClient(pg);
  db = drizzle(pg, { schema });
  await seed(db);

  const vc = await new ValkeyContainer('valkey/valkey:8.0.12').start();
  valkeyContainer = vc;
  redis = new Redis({ host: vc.getHost(), port: vc.getPort() });

  await pg`insert into tenants (slug, name, status, kvkk_addon) values ('acme', 'ACME', 'active', false)`;
  tenantId = (await pg`select id from tenants where slug = 'acme'`)[0]!.id as string;
  await pg`insert into tenant_policies (tenant_id, policy) values (${tenantId}, ${JSON.stringify({ atQuotaLimit: 'downgrade' })}::jsonb)`;
  const dept = await pg`insert into departments (tenant_id, name, policy_override)
                        values (${tenantId}, 'hr', ${JSON.stringify({ atQuotaLimit: 'block', pii: { mode: 'block' } })}::jsonb) returning id`;
  deptId = dept[0]!.id as string;
  await pg`insert into users (tenant_id, keycloak_id, email, name, status, department_id)
           values (${tenantId}, 'kc-x', 'ayse@acme.test', 'Ayşe', 'active', ${deptId})`;
  userId = (await pg`select id from users where email = 'ayse@acme.test'`)[0]!.id as string;
}, 240_000);

afterAll(async () => {
  redis?.quit();
  await valkeyContainer?.stop().catch(() => undefined);
  await pg?.end();
  await pgContainer?.stop().catch(() => undefined);
});

describe('P1-10 effective policy cache + policy.changed invalidation', () => {
  it('merges the department override over the tenant policy', async () => {
    const src = new DbPolicySource(pgUri, redis);
    await src.start();
    const eff = await src.effectivePolicy(tenant(), user());
    // department overrides atQuotaLimit downgrade → block and sets pii.mode
    expect(eff.policy.atQuotaLimit).toBe('block');
    expect(eff.pii.mode).toBe('block');

    // user without a department gets the plain tenant policy
    const plain = await src.effectivePolicy(tenant(), {
      ...user(),
      id: '00000000-0000-0000-0000-000000000009',
      departmentId: undefined,
    });
    expect(plain.policy.atQuotaLimit).toBe('downgrade');
    expect(plain.pii.mode).toBe('mask');
    await src.close();
  });

  it('caches the merged policy (second call does not hit Postgres)', async () => {
    await redis.flushdb();
    const src = new DbPolicySource(pgUri, redis);
    await src.start();
    const first = await src.effectivePolicy(tenant(), user());
    expect(first.policy.atQuotaLimit).toBe('block');

    // change the DB row directly; the cached value must still be served
    await pg`update departments set policy_override = '{"atQuotaLimit":"overage"}'::jsonb where id = ${deptId}`;
    const cached = await src.effectivePolicy(tenant(), user());
    expect(cached.policy.atQuotaLimit).toBe('block');
    await src.close();
  });

  it('invalidates on policy.changed within 30 s (immediately when subscribed)', async () => {
    await redis.flushdb();
    // Deterministic starting state, independent of earlier tests.
    await pg`update departments set policy_override = '{"atQuotaLimit":"block","pii":{"mode":"block"}}'::jsonb where id = ${deptId}`;
    const src = new DbPolicySource(pgUri, redis);
    await src.start();

    const cached = await src.effectivePolicy(tenant(), user());
    expect(cached.policy.atQuotaLimit).toBe('block'); // still the old override

    // The console edits the department override, then publishes.
    await pg`update departments set policy_override = '{}'::jsonb where id = ${deptId}`;
    await publishPolicyChanged(redis, tenantId);

    // give the subscriber a moment to process the notification
    await new Promise((r) => setTimeout(r, 250));

    const after = await src.effectivePolicy(tenant(), user());
    expect(after.policy.atQuotaLimit).toBe('downgrade'); // fresh from DB
    await src.close();
  });

  it('publishes on the documented channel name', async () => {
    expect(POLICY_CHANGED_CHANNEL).toBe('policy.changed');
  });

  it('applies the department override end to end: best hidden, then visible after policy.changed', async () => {
    await redis.flushdb();
    await pg`update departments set policy_override = '{"aliases":{"auto":true,"fast":true,"best":false,"tr-local":false}}'::jsonb where id = ${deptId}`;

    const KEY = 'sk-sme-t-policye2e0000000000000000';
    await pg`insert into gateway_keys (tenant_id, key_hash, prefix, type)
             values (${tenantId}, ${hashGatewayKey(KEY)}, ${KEY.split('-')[3]!.slice(0, 8)}, 'tenant')`;
    await pg`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
             values (${tenantId}, ${month()}, 1000000, 200000, 40)`;

    const { DbTenantStore } = await import('../src/db-stores.js');
    const tenants = new DbTenantStore(pgUri, null);
    const src = new DbPolicySource(pgUri, redis);
    await src.start();

    const mock = buildMockApp({});
    await mock.listen({ host: '127.0.0.1', port: 0 });
    const addr = mock.server.address();
    const mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;

    const gw = buildGateway({
      litellmBaseUrl: mockUrl,
      litellmApiKey: 'test',
      tenants,
      quota: new MemoryQuotaStore(),
      usage: new MemoryUsageSink(),
      policySource: src,
      logger: createLogger('test', { level: 'silent' }),
    });

    const H = { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.test' };
    const before = await gw.inject({ method: 'GET', url: '/v1/models', headers: H });
    expect(before.statusCode).toBe(200);
    expect(before.json().data.map((m: { id: string }) => m.id)).not.toContain('best');

    // Console re-enables best for the department and publishes the change.
    await pg`update departments set policy_override = '{}'::jsonb where id = ${deptId}`;
    await publishPolicyChanged(redis, tenantId);
    await new Promise((r) => setTimeout(r, 250));

    const after = await gw.inject({ method: 'GET', url: '/v1/models', headers: H });
    expect(after.statusCode).toBe(200);
    expect(after.json().data.map((m: { id: string }) => m.id)).toContain('best');

    await gw.close();
    await tenants.close();
    await src.close();
    await mock.close();
  }, 120_000);
});
