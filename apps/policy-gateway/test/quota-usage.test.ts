// SPDX-License-Identifier: AGPL-3.0-only
// P1-09 + P1-14 acceptance: quota reserve/settle is atomic in Valkey (Lua);
// usage_events land in Postgres; when Postgres is down they park in a Valkey
// outbox and replay without loss and without double-counting.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ValkeyContainer } from '@testcontainers/valkey';
import { Redis } from 'ioredis';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@katip/db';
import { migrateWithClient, seed } from '@katip/db';
import { ValkeyQuotaStore, DbUsageSink } from '../src/db-stores.js';
import { DbTenantStore } from '../src/db-stores.js';
import { buildGateway } from '../src/app.js';
import { buildMockApp } from '@katip/mock-llm';
import { createLogger, hashGatewayKey } from '@katip/shared';
import type { FastifyInstance } from 'fastify';
import type { Reservation, Tenant, UsageEvent } from '../src/stores.js';
import { DEFAULT_POLICY } from '@katip/policy-engine';

let pg: postgres.Sql;
let pgUri: string;
let db: PostgresJsDatabase<typeof schema>;
let pgContainer: Awaited<ReturnType<PostgreSqlContainer['start']>> | null = null;
let redis: Redis;
let valkeyContainer: Awaited<ReturnType<ValkeyContainer['start']>> | null = null;

const tenant = (over: Partial<Tenant> = {}): Tenant => ({
  id: '00000000-0000-0000-0000-000000000001',
  slug: 'acme',
  status: 'active',
  policy: { ...DEFAULT_POLICY },
  pii: { mode: 'off' },
  kvkkAddon: false,
  limits: { standard: 1_000, premium: 200 },
  ...over,
});

const event = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  tenantId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000010',
  departmentId: undefined,
  ts: new Date().toISOString(),
  alias: 'fast',
  modelId: 'std-deepseek-v4-flash',
  modelClass: 'standard',
  ruleId: 'fast',
  inputTokens: 100,
  outputTokens: 50,
  costMicroUsd: 15,
  fallback: false,
  overage: false,
  piiEntities: {},
  conversationId: undefined,
  source: 'chat',
  ...over,
});

let sink: DbUsageSink;
let quotaStore: ValkeyQuotaStore;
let mockUrl: string;
let mockApp: ReturnType<typeof buildMockApp> | null = null;

beforeAll(async () => {
  const pgc = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  pgContainer = pgc;
  pgUri = pgc.getConnectionUri();
  pg = postgres(pgUri, { max: 1 });
  await migrateWithClient(pg);
  db = drizzle(pg, { schema });
  await seed(db); // tenants? not needed, but FKs need users

  const vc = await new ValkeyContainer('valkey/valkey:8.0.12').start();
  valkeyContainer = vc;
  redis = new Redis({ host: vc.getHost(), port: vc.getPort() });

  // FK targets for usage_events + gateway auth
  await pg`insert into tenants (slug, name, status, kvkk_addon) values ('acme', 'ACME', 'active', false)`;
  const tid = (await pg`select id from tenants where slug = 'acme'`)[0]!.id as string;
  await pg`insert into users (tenant_id, keycloak_id, email, name, status)
           values (${tid}, 'kc-x', 'ayse@acme.test', 'Ayşe', 'active')`;
  const uid = (await pg`select id from users where email = 'ayse@acme.test'`)[0]!.id as string;
  // Limits the gateway's DbTenantStore joins tenant_limits for; a missing row
  // means zero quota and every request would 429.
  await pg`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
           values (${tid}, ${month()}, 1000000, 200000, 40)`;
  const [t] = [await pg`select id from tenants where slug = 'acme'`];
  // re-point ids at the seeded rows
  const tn = tenant();
  tn.id = tid;
  const ev = event();
  ev.tenantId = tid;
  ev.userId = uid;
  seededTenantId = tid;
  seededUserId = uid;
  void t;

  quotaStore = new ValkeyQuotaStore(redis);
  // Auto-drain disabled in tests: drainOutbox() is called explicitly.
  sink = new DbUsageSink(pgUri, { redis, drainIntervalMs: 0 });

  // Mock LiteLLM upstream for the end-to-end test.
  mockApp = buildMockApp({});
  await mockApp.listen({ host: '127.0.0.1', port: 0 });
  const addr = mockApp.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
}, 240_000);

let seededTenantId = '';
let seededUserId = '';

afterAll(async () => {
  await mockApp?.close().catch(() => undefined);
  await sink?.close().catch(() => undefined);
  redis?.quit();
  await valkeyContainer?.stop().catch(() => undefined);
  await pg?.end();
  await pgContainer?.stop().catch(() => undefined);
});

const month = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

describe('P1-09 Valkey quota reserve/settle', () => {
  it('allows within limit, settles to actual, and stays >= 0', async () => {
    await redis.flushdb();
    const t = tenant();
    const r1 = await quotaStore.reserve(t, 'standard', 300);
    expect(r1.decision).toBe('allow');
    expect(r1.reservation?.amount).toBe(300);

    const used = await redis.get(`quota:${t.id}:${month()}:standard`);
    expect(used).toBe('300');
    expect(await quotaStore.available(t, 'standard')).toBe(true);

    await quotaStore.settle(r1.reservation!, 250);
    expect(await redis.get(`quota:${t.id}:${month()}:standard`)).toBe('250');
  });

  it('blocks when over limit and behaviour is block; does not increment', async () => {
    await redis.flushdb();
    const t = tenant({ policy: { ...DEFAULT_POLICY, atQuotaLimit: 'block' } });
    const over = await quotaStore.reserve(t, 'standard', 1_001);
    expect(over.decision).toBe('block');
    expect(over.reservation).toBeUndefined();
    expect(await redis.get(`quota:${t.id}:${month()}:standard`)).toBeNull();

    // after a partial reserve + settle, a follow-up beyond the limit blocks
    const r = await quotaStore.reserve(t, 'standard', 800);
    expect(r.decision).toBe('allow');
    await quotaStore.settle(r.reservation!, 800);
    const r2 = await quotaStore.reserve(t, 'standard', 300);
    expect(r2.decision).toBe('block');
  });

  it('downgrades premium when behaviour is downgrade', async () => {
    await redis.flushdb();
    const t = tenant({ policy: { ...DEFAULT_POLICY, atQuotaLimit: 'downgrade' } });
    // Exhaust the premium counter, then exceed it.
    const r1 = await quotaStore.reserve(t, 'premium', 150);
    expect(r1.decision).toBe('allow');
    const r2 = await quotaStore.reserve(t, 'premium', 100);
    expect(r2.decision).toBe('downgrade');
    expect(r2.reservation).toBeUndefined();
    // counter unchanged by the downgrade decision
    expect(await redis.get(`quota:${t.id}:${month()}:premium`)).toBe('150');
  });

  it('overage behaviour continues and flags the reservation', async () => {
    await redis.flushdb();
    const t = tenant({ policy: { ...DEFAULT_POLICY, atQuotaLimit: 'overage' } });
    const r1 = await quotaStore.reserve(t, 'standard', 900);
    expect(r1.decision).toBe('allow');
    const r2 = await quotaStore.reserve(t, 'standard', 200);
    expect(r2.decision).toBe('overage');
    expect(r2.reservation?.overage).toBe(true);
    expect(await redis.get(`quota:${t.id}:${month()}:standard`)).toBe('1100');
  });

  it('settle targets the reservation month, not the current month', async () => {
    await redis.flushdb();
    // Seed the old-month bucket as an earlier reservation would have.
    await redis.set(`quota:${tenant().id}:200001:standard`, '500');
    const r: Reservation = {
      tenantId: tenant().id,
      cls: 'standard',
      amount: 500,
      overage: false,
      month: '200001', // ancient month bucket
    };
    await quotaStore.settle(r, 400);
    expect(await redis.get(`quota:${r.tenantId}:200001:standard`)).toBe('400');
    expect(await redis.exists(`quota:${r.tenantId}:${month()}:standard`)).toBe(0);
  });

  it('arms the TTL only on first write of a month bucket', async () => {
    await redis.flushdb();
    const t = tenant();
    const r1 = await quotaStore.reserve(t, 'standard', 100);
    expect(r1.decision).toBe('allow');
    const ttl1 = await redis.ttl(`quota:${t.id}:${month()}:standard`);
    expect(ttl1).toBeGreaterThan(0);

    // Simulate month-end rollover: remove TTL, then settle must not re-arm it.
    await redis.persist(`quota:${t.id}:${month()}:standard`);
    await quotaStore.settle(r1.reservation!, 100);
    expect(await redis.ttl(`quota:${t.id}:${month()}:standard`)).toBe(-1);
  });
});

describe('P1-14 usage_events writer + outbox', () => {
  it('writes events to Postgres', async () => {
    await redis.flushdb();
    await sink.record(event({ tenantId: seededTenantId, userId: seededUserId }));
    const rows = await pg`select * from usage_events where tenant_id = ${seededTenantId}`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect(row.alias).toBe('fast');
    expect(row.class).toBe('standard');
    expect(Number(row.cost_usd_micro)).toBe(15);
    expect(Number(row.price_usd_micro)).toBe(15);
    expect(row.source).toBe('chat');
  });

  it('parks events in the Valkey outbox when Postgres is down and replays them', async () => {
    await redis.flushdb();
    // Point the sink at a closed port: every insert fails at the connection level.
    const deadUrl = new URL(pgUri);
    deadUrl.port = '1';
    const dead = new DbUsageSink(deadUrl.toString(), { redis });
    await expect(
      dead.record(event({ tenantId: seededTenantId, userId: seededUserId })),
    ).resolves.toBeUndefined();
    const parked = await redis.llen('gw:usage:outbox');
    expect(parked).toBe(1);

    // Drain via a healthy sink: the event moves into Postgres.
    const moved = await sink.drainOutbox();
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(await redis.llen('gw:usage:outbox')).toBe(0);
    const count =
      await pg`select count(*)::int as n from usage_events where tenant_id = ${seededTenantId}`;
    expect(count[0]!.n).toBeGreaterThanOrEqual(2);

    // Replaying the same raw event again (idempotency): no double count.
    const raw = JSON.stringify({
      ...event({ tenantId: seededTenantId, userId: seededUserId }),
      id: crypto.randomUUID(),
    });
    await redis.rpush('gw:usage:outbox', raw);
    await redis.rpush('gw:usage:outbox', raw); // same id twice
    await sink.drainOutbox();
    const after =
      await pg`select count(*)::int as n from usage_events where tenant_id = ${seededTenantId}`;
    expect(after[0]!.n).toBe(count[0]!.n + 1);
  });

  it('moves unreplayable events to the dead-letter list', async () => {
    await redis.flushdb();
    // Server-side rejection: the user id is not a valid uuid (SQLSTATE 22P02).
    const bad = event({
      tenantId: seededTenantId,
      userId: 'not-a-uuid',
    });
    await redis.rpush('gw:usage:outbox', JSON.stringify({ ...bad, id: crypto.randomUUID() }));
    const moved = await sink.drainOutbox();
    expect(moved).toBe(0);
    expect(await redis.llen('gw:usage:dead')).toBe(1);
    expect(await redis.llen('gw:usage:outbox')).toBe(0);
  });
});

describe('P1-09 + P1-14 end to end through the gateway pipeline', () => {
  it('chat: quota reserved in Valkey, usage row written, settled to actual', async () => {
    await redis.flushdb();
    const KEY = 'sk-sme-t-e2equota0000000000000000';
    await pg`insert into gateway_keys (tenant_id, key_hash, prefix, type)
             values (${seededTenantId}, ${hashGatewayKey(KEY)}, ${KEY.split('-')[3]!.slice(0, 8)}, 'tenant')`;

    const tenants = new DbTenantStore(pgUri, null);
    const usage = new DbUsageSink(pgUri, { redis, drainIntervalMs: 0 });
    const gw: FastifyInstance = buildGateway({
      litellmBaseUrl: mockUrl,
      litellmApiKey: 'test',
      tenants,
      quota: quotaStore,
      usage,
      logger: createLogger('test', { level: 'silent' }),
    });

    const res = await gw.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.test' },
      payload: { model: 'fast', messages: [{ role: 'user', content: 'merhaba dünya' }] },
    });
    expect(res.statusCode).toBe(200);

    // Quota counter settled to actual usage (mock returns usage tokens).
    const used = await redis.get(`quota:${seededTenantId}:${month()}:standard`);
    expect(Number(used)).toBeGreaterThan(0);

    // usage row landed
    const rows =
      await pg`select * from usage_events where tenant_id = ${seededTenantId} and alias = 'fast'`;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows.at(-1)!;
    expect(Number(row.input_tokens)).toBeGreaterThan(0);
    expect(Number(row.output_tokens)).toBeGreaterThan(0);
    expect(Number(row.cost_usd_micro)).toBeGreaterThan(0);

    await gw.close();
    await tenants.close();
    await usage.close();
  }, 120_000);
});
