// SPDX-License-Identifier: AGPL-3.0-only
// Storing the rate on real Postgres, as the role it really connects with.
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
}, 240_000);

afterAll(async () => {
  await store?.close();
  await provider?.end();
  await admin?.end();
  await container?.stop();
});

const rate = { date: '2026-11-03', currency: 'USD', buying: '49.9094', selling: '49.9993' };

describe('exchange rates', () => {
  it('stores the rate exactly as published', async () => {
    expect(await store.saveFxRate(rate)).toBe(true);
    const [row] = await admin`select rate_date::text, currency, buying::text, selling::text
      from fx_rates where rate_date = ${rate.date}`;
    expect(row).toEqual({
      rate_date: rate.date,
      currency: 'USD',
      buying: '49.9094',
      selling: '49.9993',
    });
  });

  it('keeps the first rate for a date: an invoice may already rely on it', async () => {
    expect(await store.saveFxRate({ ...rate, selling: '60.0000' })).toBe(false);
    const rows = await admin`select selling::text from fx_rates where rate_date = ${rate.date}`;
    expect(rows).toEqual([{ selling: '49.9993' }]);
  });

  it("can't be changed or removed by the role that adds them", async () => {
    await expect(provider`update fx_rates set selling = 1`).rejects.toThrow(/permission denied/);
    await expect(provider`delete from fx_rates`).rejects.toThrow(/permission denied/);
  });
});
