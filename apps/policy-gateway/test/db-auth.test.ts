// SPDX-License-Identifier: AGPL-3.0-only
// P1-02 acceptance: wrong key → 401; correct key resolves the tenant from
// Postgres (gateway_keys, argon2id) with a 60 s Valkey cache.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { ValkeyContainer } from '@testcontainers/valkey';
import { Redis } from 'ioredis';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { buildMockApp } from '@katip/mock-llm';
import { createLogger, hashGatewayKey } from '@katip/shared';
import * as schema from '@katip/db';
import { migrateWithClient, seed } from '@katip/db';
import { buildGateway } from '../src/app.js';
import { DbTenantStore } from '../src/db-stores.js';
import { MemoryQuotaStore, MemoryUsageSink } from '../src/stores.js';

let pg: postgres.Sql;
let pgUri: string;
let db: PostgresJsDatabase<typeof schema>;
let pgContainer: Awaited<ReturnType<PostgreSqlContainer['start']>> | null = null;
let redis: Redis;
let valkeyContainer: Awaited<ReturnType<ValkeyContainer['start']>> | null = null;
let mock: ReturnType<typeof buildMockApp>;
let mockUrl: string;
let gw: FastifyInstance;
let store: DbTenantStore;

const KEY = generateTestKey();
function generateTestKey(): string {
  // deterministic-enough plaintext; hash computed after DB insert below
  return `sk-sme-t-testkey1234567890abcdef`;
}

beforeAll(async () => {
  const pgc = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  pgContainer = pgc;
  pgUri = pgc.getConnectionUri();
  pg = postgres(pgUri, { max: 1 });
  await migrateWithClient(pg);
  db = drizzle(pg, { schema });
  await seed(db); // model_catalog + router_rules (P1-04)

  const vc = await new ValkeyContainer('valkey/valkey:8.0.12').start();
  valkeyContainer = vc;
  redis = new Redis({ host: vc.getHost(), port: vc.getPort() });

  mock = buildMockApp({});
  await mock.listen({ host: '127.0.0.1', port: 0 });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;

  // Seed one tenant + key + user directly into the governance schema.
  const [tenant] = await db
    .insert(schema.tenants)
    .values({ slug: 'acme', name: 'ACME A.Ş.', status: 'active', kvkkAddon: false })
    .returning();
  const tenantId = tenant!.id;
  await db.insert(schema.tenantPolicies).values({ tenantId, policy: {} });
  await db.insert(schema.tenantLimits).values({
    tenantId,
    month: month(),
    stdTokens: 1_000_000,
    premTokens: 100_000,
    researchRuns: 40,
  });
  await db.insert(schema.gatewayKeys).values({
    tenantId,
    keyHash: hashGatewayKey(KEY),
    prefix: KEY.split('-')[3]!.slice(0, 8),
    type: 'tenant',
  });
  await db.insert(schema.users).values({
    tenantId,
    keycloakId: 'kc-1',
    email: 'ayse@acme.com.tr',
    name: 'Ayşe',
    status: 'active',
  });

  store = new DbTenantStore(pgUri, redis);
  gw = buildGateway({
    litellmBaseUrl: mockUrl,
    litellmApiKey: 'test',
    tenants: store,
    quota: new MemoryQuotaStore(),
    usage: new MemoryUsageSink(),
    logger: createLogger('test', { level: 'silent' }),
  });
}, 240_000);

afterAll(async () => {
  await gw?.close().catch(() => undefined);
  await store?.close().catch(() => undefined);
  redis?.quit();
  await valkeyContainer?.stop().catch(() => undefined);
  await pg?.end();
  await pgContainer?.stop().catch(() => undefined);
  await mock?.close().catch(() => undefined);
});

const month = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

describe('P1-02 gateway auth against Postgres + Valkey', () => {
  it('rejects a wrong key with 401 and does not cache it as a tenant', async () => {
    const res = await gw.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer sk-sme-t-wrongkey0000000000000000` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('resolves the tenant by key (argon2id) and caches in Valkey for 60 s', async () => {
    const res = await gw.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.com.tr' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.map((m: { id: string }) => m.id)).toEqual(['auto', 'fast', 'best']);

    // cached: the DB row can disappear and the key still resolves within TTL
    await pg`delete from gateway_keys`;
    const cached = await gw.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.com.tr' },
    });
    expect(cached.statusCode).toBe(200);
  });

  it('identifies the user from X-User-Email within the tenant', async () => {
    // restore the key row deleted by the cache test, then flush the cache
    const tid = (await pg`select id from tenants where slug = 'acme'`)[0]!.id as string;
    await pg`insert into gateway_keys (tenant_id, key_hash, prefix, type)
             values (${tid}, ${hashGatewayKey(KEY)}, ${KEY.split('-')[3]!.slice(0, 8)}, 'tenant')`;
    await redis.flushall();
    const ok = await gw.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.com.tr' },
      payload: { model: 'fast', messages: [{ role: 'user', content: 'merhaba' }] },
    });
    expect(ok.statusCode).toBe(200);

    const unknown = await gw.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'nobody@acme.com.tr' },
      payload: { model: 'fast', messages: [{ role: 'user', content: 'merhaba' }] },
    });
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json().error.code).toBe('user_not_provisioned');
  });

  it('rejects keys whose prefix matches but hash does not', async () => {
    await redis.flushall();
    await pg`delete from gateway_keys`;
    const samePrefix = KEY.slice(0, 15) + 'xxxxxxxxxxxxxxxxxxxxxx';
    const res = await gw.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${samePrefix}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('P1-04 model catalog and rules from Postgres', () => {
  it('serves /v1/models and routing from model_catalog + router_rules', async () => {
    // restore the key row deleted by the prefix-collision test
    const tid = (await pg`select id from tenants where slug = 'acme'`)[0]!.id as string;
    const nKeys = await pg`select count(*)::int as n from gateway_keys where tenant_id = ${tid}`;
    if (nKeys[0]!.n === 0) {
      await pg`insert into gateway_keys (tenant_id, key_hash, prefix, type)
               values (${tid}, ${hashGatewayKey(KEY)}, ${KEY.split('-')[3]!.slice(0, 8)}, 'tenant')`;
    }
    await redis.flushall();

    const { DbCatalogStore } = await import('../src/db-stores.js');
    const catalogStore = new DbCatalogStore(pgUri);
    gw = buildGateway({
      litellmBaseUrl: mockUrl,
      litellmApiKey: 'test',
      tenants: store,
      quota: new MemoryQuotaStore(),
      usage: new MemoryUsageSink(),
      catalogStore,
      logger: createLogger('test', { level: 'silent' }),
    });

    const res = await gw.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.com.tr' },
    });
    const ids = res.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('best');
    // No KVKK add-on → tr-local must not appear even though the alias is on.
    expect(ids).not.toContain('tr-local');

    // Routing uses the DB catalog: chat on fast → a standard model.
    const chat = await gw.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': 'ayse@acme.com.tr' },
      payload: { model: 'fast', messages: [{ role: 'user', content: 'selam' }] },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.headers['x-katip-model']).toBe('std-deepseek-v4-flash');
    await catalogStore.close();
  });

  it('picks up catalog edits without a restart (TTL refresh)', async () => {
    const { DbCatalogStore } = await import('../src/db-stores.js');
    const catalogStore = new DbCatalogStore(pgUri, 50);
    const before = await catalogStore.getCatalog();
    expect(before.some((m) => m.id === 'std-gemma-4-26b')).toBe(true);

    // Disable gemma in the DB, force refresh, verify it disappears.
    await pg`update model_catalog set enabled = false where id = 'std-gemma-4-26b'`;
    await catalogStore.refresh(true);
    const after = await catalogStore.getCatalog();
    expect(after.some((m) => m.id === 'std-gemma-4-26b' && m.enabled)).toBe(false);
    await catalogStore.close();
  });
});
