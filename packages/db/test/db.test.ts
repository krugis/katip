// SPDX-License-Identifier: AGPL-3.0-only
// P1-17 acceptance: migrations run forward from empty; seed provides demo data.
// P1-18 acceptance (preview): RLS isolates tenants on every tenant-owned table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { migrateWithClient } from '../src/migrate.js';
import { seed } from '../src/seed.js';
import { TENANT_OWNED_TABLES } from '../src/rls.js';
import * as schema from '../src/schema.js';

const tenantOwned = [...TENANT_OWNED_TABLES];

let client: postgres.Sql;
let db: PostgresJsDatabase<typeof schema>;
let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | null = null;
let containerUri: string | null = null;

const DB_URL = process.env['TEST_DATABASE_URL'] ?? '';

beforeAll(async () => {
  if (DB_URL) {
    containerUri = DB_URL;
    client = postgres(DB_URL, { max: 1 });
  } else {
    const c = await new PostgreSqlContainer('postgres:16.9-alpine').start();
    container = c;
    containerUri = c.getConnectionUri();
    client = postgres(containerUri, { max: 1 });
  }
  db = drizzle(client, { schema });
}, 120_000);

afterAll(async () => {
  await client.end();
  if (container) await container.stop();
});

describe('migrate + seed', () => {
  it('runs forward from empty and is idempotent', async () => {
    const applied = await migrateWithClient(client);
    expect(applied.length).toBeGreaterThan(0);

    // Idempotent: second run applies nothing new and does not throw.
    const again = await migrateWithClient(client);
    expect(again).toEqual(applied);

    const tables = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_tables where schemaname = 'public'`,
    );
    expect(tables[0]!.n).toBeGreaterThanOrEqual(23);
  });

  it('seeds plans, catalog, rules and the demo tenant', async () => {
    await seed(db);
    // Idempotent seed.
    await seed(db);

    const plans = await db.execute<{ code: string }>(sql`select code from plans order by code`);
    expect(plans.map((p) => p.code)).toEqual([
      'business',
      'community',
      'kvkk_addon',
      'starter',
      'studio',
    ]);

    const models = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from model_catalog`,
    );
    expect(models[0]!.n).toBe(7);

    const rules = await db.execute<{ n: number }>(sql`select count(*)::int as n from router_rules`);
    expect(rules[0]!.n).toBe(7);

    const demo = await db.execute<{ slug: string; users: number }>(
      sql`select t.slug, (select count(*)::int from users u where u.tenant_id = t.id) as users
          from tenants t where slug = 'demo'`,
    );
    expect(demo[0]!.slug).toBe('demo');
    expect(demo[0]!.users).toBe(3);
  });
});

describe('row-level security', () => {
  it('blocks cross-tenant reads and writes on every tenant-owned table', async () => {
    const rows = await db.execute<{ tenant_id: string }>(
      sql`select id as tenant_id from tenants where slug = 'demo'`,
    );
    const demoTenant = rows[0]!.tenant_id;
    const otherTenant = crypto.randomUUID();

    // Tenant A session: set_config must run inside the same transaction as the query
    // (isolation level true = transaction-local), so wrap reads/writes in begin().
    const a = postgres(DB_URL || containerUri!, { max: 1 });
    await a`drop role if exists katip_app`;
    await a`create role katip_app login password 'katip_app'`;
    await a`grant usage on schema public to katip_app`;
    await a`grant select, insert, update, delete on all tables in schema public to katip_app`;
    await a.end();

    const app = postgres(DB_URL || containerUri!, {
      username: 'katip_app',
      password: 'katip_app',
      max: 1,
    });

    // Read: demo tenant's own users are visible…
    const own = await app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${demoTenant}, true)`;
      return tx`select count(*)::int as n from users`;
    });
    expect(own[0]!.n).toBe(3);
    // …but inserting a row for another tenant is rejected.
    await expect(
      app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${demoTenant}, true)`;
        await tx`insert into users (tenant_id, keycloak_id, email, name) values (${otherTenant}, ${'kc-' + otherTenant}, 'x@y.com', 'X')`;
      }),
    ).rejects.toThrow();
    // And an UPDATE targeting another tenant's rows affects none.
    const updated = await app.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${demoTenant}, true)`;
      return tx`update users set name = 'hacked' where tenant_id = ${otherTenant}`;
    });
    expect(updated.count).toBe(0);
    await app.end();
  });

  it('enables RLS with the tenant_isolation policy on every tenant-owned table', async () => {
    const rows = await db.execute<{
      relname: string;
      relrowsecurity: boolean;
      policies: number;
    }>(sql`
      select c.relname, c.relrowsecurity,
             (select count(*)::int from pg_policies p
               where p.tablename = c.relname and p.policyname = 'tenant_isolation') as policies
      from pg_class c join pg_tables t on t.tablename = c.relname
      where t.schemaname = 'public' and c.relname = any(${sql.raw(`ARRAY[${tenantOwned.map((t) => `'${t}'`).join(',')}]`)}::text[])
    `);
    expect(rows.length).toBe(tenantOwned.length);
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} must have RLS enabled`).toBe(true);
      expect(r.policies, `${r.relname} must have the tenant_isolation policy`).toBe(1);
    }
  });

  it('prevents UPDATE/DELETE on audit_log for app roles (append-only)', async () => {
    const app2 = postgres(DB_URL || containerUri!, {
      username: 'katip_app',
      password: 'katip_app',
      max: 1,
    });
    // INSERT is allowed for one's own tenant_id…
    await app2.begin(async (tx) => {
      const own = crypto.randomUUID();
      await tx`select set_config('app.tenant_id', ${own}, true)`;
      await tx`insert into audit_log (id, tenant_id, actor_type, action, target_type) values (${crypto.randomUUID()}, ${own}, 'system', 'test', 'test')`;
    });
    // …but UPDATE is rejected: the test role's grant mirrors the production app role,
    // which never receives UPDATE/DELETE on audit_log (LLD-05 append-only).
    const a2 = postgres(DB_URL || containerUri!, { max: 1 });
    await a2`revoke update, delete on audit_log from katip_app`;
    await a2.end();
    await expect(
      app2.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${crypto.randomUUID()}, true)`;
        await tx`update audit_log set action = 'tampered'`;
      }),
    ).rejects.toThrow(/permission denied/);
    await app2.end();
  });
});
