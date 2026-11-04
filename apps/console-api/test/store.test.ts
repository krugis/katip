// SPDX-License-Identifier: AGPL-3.0-only
// Row-level security as console-api really connects: as katip_console (CLAUDE.md rule 4).
import { migrateWithClient } from '@katip/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbConsoleStore } from '../src/stores.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let console_: postgres.Sql;
let store: DbConsoleStore;
let a: string;
let b: string;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await admin.unsafe(`ALTER ROLE katip_console PASSWORD 'console-test-password'`);
  const add = async (slug: string, email: string) => {
    const rows = await admin`insert into tenants (slug, name, status, kvkk_addon)
      values (${slug}, ${slug}, 'active', false) returning id`;
    const id = rows[0]!.id as string;
    await admin`insert into users (tenant_id, keycloak_id, email, name, role, status)
      values (${id}, ${email}, ${email}, ${email}, 'user', 'active')`;
    return id;
  };
  a = await add('tenant-a', 'ayse@a.test');
  b = await add('tenant-b', 'mehmet@b.test');
  const url = new URL(container.getConnectionUri());
  url.username = 'katip_console';
  url.password = 'console-test-password';
  console_ = postgres(url.toString(), { max: 1 });
  store = new DbConsoleStore(url.toString());
}, 240_000);

afterAll(async () => {
  await store?.close();
  await console_?.end();
  await admin?.end();
  await container?.stop();
});

describe('the console role', () => {
  it('is not a superuser and does not bypass RLS', async () => {
    const [r] =
      await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'katip_console'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('sees no users without a tenant context', async () => {
    expect(await console_`select id from users`).toHaveLength(0);
  });

  it('sees only that tenant, even with no tenant filter in the query', async () => {
    const rows = await console_.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a}, true)`;
      return tx`select tenant_id from users`;
    });
    expect(rows.map((r) => r['tenant_id'])).toEqual([a]);
  });

  it("can't change users outside its tenant context", async () => {
    const none = await console_`update users set status = 'disabled' returning id`;
    expect(none).toHaveLength(0);
    const other = await console_.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a}, true)`;
      return tx`update users set status = 'disabled' where tenant_id = ${b} returning id`;
    });
    expect(other).toHaveLength(0);
    const [row] = await admin`select status from users where tenant_id = ${b}`;
    expect(row!['status']).toBe('active');
  });

  it.each([
    ['change a user email', `update users set email = 'x'`],
    ['read gateway keys', `select * from gateway_keys`],
    ['read usage', `select * from usage_events`],
    ['change the audit log', `update audit_log set action = 'x'`],
    ['delete from the audit log', `delete from audit_log`],
    ['change tenants', `update tenants set status = 'suspended'`],
    ['drop a table', `drop table users`],
  ])('is denied: %s', async (_label, statement) => {
    await expect(console_.unsafe(statement)).rejects.toThrow(/permission denied|must be owner/);
  });
});

describe('DbConsoleStore on that role', () => {
  it('finds companies', async () => {
    expect((await store.tenantBySlug('tenant-a'))?.id).toBe(a);
    expect((await store.tenantById(b))?.slug).toBe('tenant-b');
    expect(await store.tenantBySlug('nope')).toBeNull();
    expect((await store.listTenants()).map((t) => t.slug)).toContain('tenant-b');
  });

  it('finds a user only in their own tenant', async () => {
    expect((await store.findUser(a, 'ayse@a.test'))?.email).toBe('ayse@a.test');
    expect(await store.findUser(a, 'mehmet@b.test')).toBeNull();
  });

  it('is ready once migrated', async () => {
    expect(await store.ready()).toBe(true);
  });

  it("counts every company's failed jobs for monitoring, and nothing else of them", async () => {
    await admin`insert into jobs (type, tenant_id, status, payload, updated_at) values
      ('tenant.purge', ${a}, 'failed', '{"slug":"tenant-a"}', now()),
      ('tenant.purge', ${b}, 'failed', '{"slug":"tenant-b"}', now()),
      ('tenant.purge', ${b}, 'failed', '{"slug":"tenant-b"}', now() - interval '2 days'),
      ('tenant.create', ${a}, 'done', '{"slug":"tenant-a"}', now())`;
    const h = await store.platformHealth();
    expect(h.failedJobs).toEqual([{ type: 'tenant.purge', failed: 2 }]);
    expect(h.tenants).toEqual([{ status: 'active', count: 2 }]);
    expect(h.dailyRun).toBeNull();
    // Still no rows of its own: only the counts.
    expect(await console_`select id from jobs`).toHaveLength(0);
  });
});

describe('the monitoring role (P1-43)', () => {
  it('reads statistics, and no rows', async () => {
    const [r] =
      await admin`select rolsuper, rolbypassrls from pg_roles where rolname = 'katip_monitor'`;
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false });
    await admin.unsafe(`ALTER ROLE katip_monitor PASSWORD 'monitor-test-password'`);
    const url = new URL(container.getConnectionUri());
    url.username = 'katip_monitor';
    url.password = 'monitor-test-password';
    const monitor = postgres(url.toString(), { max: 1 });
    try {
      const [s] = await monitor`select count(*)::int as n from pg_stat_database`;
      expect(s!['n']).toBeGreaterThan(0);
      for (const table of ['users', 'usage_events', 'audit_log', 'jobs']) {
        await expect(monitor.unsafe(`select * from ${table}`)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await monitor.end();
    }
  });
});
