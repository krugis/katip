// SPDX-License-Identifier: AGPL-3.0-only
// Row-level security as the gateway really connects: as katip_gateway, not the admin
// role the other integration tests use, which bypasses RLS (CLAUDE.md rule 4).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { migrateWithClient } from '@katip/db';
import { hashGatewayKey } from '@katip/shared';
import { DbPolicySource, DbTenantStore, DbUsageSink } from '../src/db-stores.js';
import type { Tenant, User } from '../src/stores.js';

const KEY_A = 'sk-sme-t-aaaaaaaa-secret-for-tenant-a';
const KEY_B = 'sk-sme-t-bbbbbbbb-secret-for-tenant-b';
let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let gateway: postgres.Sql;
let gatewayUrl: string;
let a: string;
let b: string;
let userA: string;
let userB: string;

const uuid = async (sql: postgres.Sql, slug: string): Promise<string> => {
  const rows = await sql`insert into tenants (slug, name, status, kvkk_addon)
    values (${slug}, ${slug}, 'active', false) returning id`;
  return rows[0]!.id as string;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await admin.unsafe(`ALTER ROLE katip_gateway PASSWORD 'gateway-test-password'`);
  a = await uuid(admin, 'tenant-a');
  b = await uuid(admin, 'tenant-b');
  for (const [t, key, email] of [
    [a, KEY_A, 'ayse@a.test'],
    [b, KEY_B, 'mehmet@b.test'],
  ] as const) {
    await admin`insert into gateway_keys (tenant_id, key_hash, prefix, type)
      values (${t}, ${hashGatewayKey(key)}, ${key.slice(9, 17)}, 'tenant')`;
    await admin`insert into users (tenant_id, keycloak_id, email, name, role, status)
      values (${t}, ${email}, ${email}, ${email}, 'user', 'active')`;
    await admin`insert into tenant_policies (tenant_id, policy)
      values (${t}, ${JSON.stringify({ pii: { mode: 'block' } })}::jsonb)`;
    await admin`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
      values (${t}, '209901', 123, 45, 1)`;
  }
  const ids = await admin`select tenant_id, id from users`;
  userA = ids.find((r) => r.tenant_id === a)!.id as string;
  userB = ids.find((r) => r.tenant_id === b)!.id as string;
  const u = new URL(container.getConnectionUri());
  u.username = 'katip_gateway';
  u.password = 'gateway-test-password';
  gatewayUrl = u.toString();
  gateway = postgres(gatewayUrl, { max: 1 });
}, 240_000);

afterAll(async () => {
  await gateway?.end();
  await admin?.end();
  await container?.stop();
});

/** A query in tenant `id`'s context, on the gateway's connection. */
const asTenant = <T>(id: string, fn: (tx: postgres.TransactionSql) => Promise<T>) =>
  gateway.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${id}, true)`;
    return fn(tx);
  }) as Promise<T>;

describe('the gateway role', () => {
  it('is not a superuser and does not bypass RLS', async () => {
    const [r] =
      await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'katip_gateway'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('sees no tenant data without a tenant context', async () => {
    expect(await gateway`select id from users`).toHaveLength(0);
    expect(await gateway`select tenant_id from tenant_policies`).toHaveLength(0);
    expect(await gateway`select tenant_id from tenant_limits`).toHaveLength(0);
  });

  it('sees no tenant data after a context ends on the same connection', async () => {
    await asTenant(a, (tx) => tx`select id from users`);
    expect(await gateway`select id from users`).toHaveLength(0);
  });

  it('sees only that tenant, even with no tenant filter in the query', async () => {
    const rows = await asTenant(a, (tx) => tx`select tenant_id from users`);
    expect(rows.map((r) => r['tenant_id'])).toEqual([a]);
  });

  it('can look up keys of any tenant, as that is how the tenant is found', async () => {
    expect(await gateway`select tenant_id from gateway_keys`).toHaveLength(2);
  });

  it("cannot write another tenant's usage", async () => {
    await expect(
      asTenant(
        a,
        (tx) => tx`insert into usage_events (tenant_id, user_id, alias, model_id, class,
          input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source)
          values (${b}, ${userB}, 'fast', 'm', 'standard', 1, 1, 1, 1, 'chat')`,
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it.each([
    ['change users', `update users set status = 'disabled'`],
    ['delete users', `delete from users`],
    ['change keys', `update gateway_keys set revoked_at = now()`],
    ['change policies', `update tenant_policies set policy = '{}'`],
    ['read the audit log', `select * from audit_log`],
    ['read invoices', `select * from invoices`],
    ['create a tenant', `insert into tenants (slug, name, status) values ('x-y-z', 'x', 'active')`],
    ['drop a table', `drop table users`],
  ])('is denied: %s', async (_label, statement) => {
    await expect(asTenant(a, (tx) => tx.unsafe(statement))).rejects.toThrow(
      /permission denied|must be owner/,
    );
  });
});

describe('the gateway stores on that role', () => {
  it('resolve a key to its tenant, with its policy and limits', async () => {
    const store = new DbTenantStore(gatewayUrl, null);
    const t = await store.findTenantByKey(KEY_A);
    expect(t).toMatchObject({ id: a, slug: 'tenant-a', limits: { standard: 123, premium: 45 } });
    expect(t?.pii.mode).toBe('block');
    expect(await store.findTenantByKey('sk-sme-t-aaaaaaaa-wrong')).toBeNull();
    await store.close();
  });

  it('find a user only in their own tenant', async () => {
    const store = new DbTenantStore(gatewayUrl, null);
    expect((await store.findUser(a, 'ayse@a.test'))?.id).toBe(userA);
    expect(await store.findUser(a, 'mehmet@b.test')).toBeNull();
    await store.close();
  });

  it('load an effective policy', async () => {
    const source = new DbPolicySource(gatewayUrl, null);
    const tenant = { id: a } as Tenant;
    const user = { id: userA, tenantId: a } as User;
    expect((await source.effectivePolicy(tenant, user)).pii.mode).toBe('block');
    await source.close();
  });

  it('write usage for the tenant', async () => {
    const sink = new DbUsageSink(gatewayUrl, { drainIntervalMs: 0 });
    await sink.record({
      tenantId: a,
      userId: userA,
      ts: new Date().toISOString(),
      alias: 'fast',
      modelId: 'm',
      modelClass: 'standard',
      ruleId: 'r',
      inputTokens: 1,
      outputTokens: 1,
      costMicroUsd: 1,
      source: 'chat',
      fallback: false,
      overage: false,
      piiEntities: {},
    } as never);
    const rows = await admin`select tenant_id from usage_events where user_id = ${userA}`;
    expect(rows.map((r) => r.tenant_id)).toEqual([a]);
    await sink.close();
  });
});
