// SPDX-License-Identifier: AGPL-3.0-only
// The retention job on real Postgres, as the role it really connects with (LLD-10 §8).
import { randomUUID } from 'node:crypto';
import { migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbProvisionerStore } from '../src/store.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let provider: postgres.Sql;
let store: DbProvisionerStore;
let tenantId: string;

const usage = (ts: string, user: string) => admin`insert into usage_events
  (id, tenant_id, user_id, ts, alias, model_id, class, input_tokens, output_tokens,
   cost_usd_micro, price_usd_micro, source)
  values (${randomUUID()}, ${tenantId}, ${user}, ${ts}::timestamptz, 'fast', 'm', 'standard',
   1, 1, 0, 0, 'chat')`;
const audit = (ts: string, action: string) => admin`insert into audit_log
  (id, tenant_id, actor_type, actor_id, action, target_type, target_id, ts)
  values (${randomUUID()}, ${tenantId}, 'system', 'test', ${action}, 'tenant', 'x', ${ts}::timestamptz)`;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await seed(drizzle(admin, { schema }), { tenant: null });
  await admin.unsafe(`ALTER ROLE katip_provider PASSWORD 'provider-test-password'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'katip_provider';
  url.password = 'provider-test-password';
  store = new DbProvisionerStore(url.toString());
  provider = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const [tenant] = await admin`insert into tenants (slug, name) values ('daily', 'D') returning id`;
  tenantId = tenant!['id'] as string;
}, 240_000);

afterAll(async () => {
  await store?.close();
  await provider?.end();
  await admin?.end();
  await container?.stop();
});

describe('retention', () => {
  it('removes usage after 24 months and audit entries after 5 years, and nothing newer', async () => {
    const user = randomUUID();
    await usage(ago(800), user);
    await usage(ago(700), user);
    await audit(ago(2000), 'too.old');
    await audit(ago(1500), 'kept');
    await admin`insert into usage_daily
      (tenant_id, day, user_id, class, model_id, input_tokens, output_tokens, cost_usd_micro)
      values (${tenantId}, ${ago(800).slice(0, 10)}::date, ${user}, 'standard', 'm', 1, 1, 0),
             (${tenantId}, ${ago(700).slice(0, 10)}::date, ${user}, 'standard', 'm', 1, 1, 0)`;

    expect(await store.enforceRetention()).toEqual({ usage: 1, usageDaily: 1, audit: 1 });

    const left = await admin`select ts from usage_events where tenant_id = ${tenantId}`;
    expect(left).toHaveLength(1);
    const daily = await admin`select day from usage_daily where tenant_id = ${tenantId}`;
    expect(daily).toHaveLength(1);
    const actions = await admin`select action from audit_log where tenant_id = ${tenantId}`;
    expect(actions.map((r) => r['action'])).toEqual(['kept']);

    expect(await store.enforceRetention()).toEqual({ usage: 0, usageDaily: 0, audit: 0 });
  });

  it('gives its role this one function, and still no way to delete directly', async () => {
    await expect(provider`delete from audit_log`).rejects.toThrow(/permission denied/);
    await expect(provider`delete from usage_events`).rejects.toThrow(/permission denied/);
  });
});

describe('recording the run', () => {
  it('can be read back as the latest run, belonging to no company', async () => {
    await store.recordDailyRun({ deleted: 1, purged: 0, failed: 0 });
    await store.recordDailyRun({ deleted: 2, purged: 0, failed: 3 });
    const [latest] = await admin`select * from latest_daily_run()`;
    expect(latest!['details']).toEqual({ deleted: 2, purged: 0, failed: 3 });
    const rows = await admin`select tenant_id from audit_log where action = 'platform.daily'`;
    expect(rows.every((r) => r['tenant_id'] === null)).toBe(true);
  });
});
