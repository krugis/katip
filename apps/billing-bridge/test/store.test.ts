// SPDX-License-Identifier: AGPL-3.0-only
// billing-bridge's own role, on a real Postgres: what it may read and write, that it sees one
// company at a time, and that the hourly sums count what the gateway's quota counts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';
import { migrateWithClient } from '@katip/db';
import { PgBillingStore } from '../src/store.js';

const PASSWORD = 'billing-test-password-0123456789abcdef';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let store: PgBillingStore;
let billingUrl: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1 });
  await migrateWithClient(admin);
  await admin.unsafe(`ALTER ROLE katip_billing PASSWORD '${PASSWORD}'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'katip_billing';
  url.password = PASSWORD;
  billingUrl = url.toString();
  store = new PgBillingStore(billingUrl);

  for (const slug of ['acme', 'beta']) {
    const [t] = await admin<{ id: string }[]>`
      insert into tenants (slug, name) values (${slug}, ${slug}) returning id`;
    ids[slug] = t!.id;
    await admin`insert into subscriptions (tenant_id, billing_cycle, status, period_start, period_end)
      values (${t!.id}, 'monthly', 'active', now(), now() + interval '1 month')`;
    await admin`insert into seats (tenant_id, plan_code, quantity) values (${t!.id}, 'business', 4)`;
    const [u] = await admin<{ id: string }[]>`
      insert into users (tenant_id, keycloak_id, email, name) values (${t!.id}, ${`kc-${slug}`},
        ${`u@${slug}.test`}, 'U') returning id`;
    const usage = [
      ['2026-11-04T10:05:00Z', 'standard', 100, 20, true],
      ['2026-11-04T10:55:00Z', 'tr', 5, 5, true],
      ['2026-11-04T10:30:00Z', 'embedding', 1, 0, true],
      ['2026-11-04T10:30:00Z', 'premium', 7, 3, true],
      ['2026-11-04T10:40:00Z', 'standard', 1_000, 1_000, false],
      ['2026-11-04T11:00:00Z', 'standard', 9, 1, true],
    ] as const;
    for (const [ts, cls, input, output, overage] of usage) {
      await admin`insert into usage_events (id, tenant_id, user_id, ts, alias, model_id, class,
          input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source, overage)
        values (gen_random_uuid(), ${t!.id}, ${u!.id}, ${ts}, 'fast', 'm', ${cls}, ${input},
          ${output}, 123, 123, 'chat', ${overage})`;
    }
  }
}, 180_000);

afterAll(async () => {
  await store?.close();
  await admin?.end();
  await container?.stop();
});

describe('katip_billing', () => {
  it('sums overage per hour by quota class: tr and embedding are standard', async () => {
    const rows = await store.overageTotals(
      ids['acme']!,
      new Date('2026-11-04T00:00:00Z'),
      new Date('2026-11-04T12:00:00Z'),
    );
    const byKey = Object.fromEntries(
      rows.map((r) => [`${r.hour.toISOString()}|${r.cls}`, r.tokens]),
    );
    expect(byKey).toEqual({
      '2026-11-04T10:00:00.000Z|standard': 131,
      '2026-11-04T10:00:00.000Z|premium': 10,
      '2026-11-04T11:00:00.000Z|standard': 10,
    });
  });

  it("can't read cost, or any company's rows outside that company's context", async () => {
    const sql = postgres(billingUrl, { max: 1 });
    try {
      await expect(sql`select cost_usd_micro from usage_events`).rejects.toThrow(/permission/);
      await expect(sql`select conversation_id from usage_events`).rejects.toThrow(/permission/);
      const none = await sql`select tenant_id from usage_events`;
      expect(none).toHaveLength(0);
      const other = await sql.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${ids['acme']!}, true)`;
        return tx`select count(*)::int as n from usage_events where tenant_id = ${ids['beta']!}`;
      });
      expect(other[0]!.n).toBe(0);
      await expect(sql`delete from billing_usage_sent`).rejects.toThrow(/permission/);
      await expect(sql`update seats set quantity = 1`).rejects.toThrow(/permission/);
      await expect(sql`select email from users`).rejects.toThrow(/permission/);
    } finally {
      await sql.end();
    }
  });

  it('records what was sent, for one company only, and marks it', async () => {
    const row = {
      hour: new Date('2026-11-04T10:00:00Z'),
      cls: 'standard' as const,
      seq: 0,
      tokens: 131,
      transactionId: 'acme-2026110410-standard',
      lagoSubscriptionId: 'acme-monthly',
      eventTs: new Date('2026-11-04T10:00:00Z'),
      status: 'pending' as const,
    };
    await store.addUsageSent(ids['acme']!, row);
    await expect(store.addUsageSent(ids['acme']!, row)).rejects.toThrow(/duplicate/);
    // Row-level security refuses a row written in one company's context for another.
    const sql = postgres(billingUrl, { max: 1 });
    try {
      await expect(
        sql.begin(async (tx) => {
          await tx`select set_config('app.tenant_id', ${ids['acme']!}, true)`;
          await tx`insert into billing_usage_sent (tenant_id, hour, class, seq, tokens,
              transaction_id, lago_subscription_id, event_ts)
            values (${ids['beta']!}, now(), 'standard', 0, 1, 'cross', 'beta-monthly', now())`;
        }),
      ).rejects.toThrow(/row-level security/);
    } finally {
      await sql.end();
    }
    const acme = await store.usageSent(ids['acme']!, new Date('2026-11-01T00:00:00Z'));
    expect(acme.map((r) => r.transactionId)).toEqual(['acme-2026110410-standard']);
    await store.markUsageSent(ids['acme']!, row.transactionId, new Date());
    const [sent] = await store.usageSent(ids['acme']!, new Date('2026-11-01T00:00:00Z'));
    expect(sent?.status).toBe('sent');
    expect(sent?.tokens).toBe(131);
  });

  it('reads seats and the subscription, and records the Lago subscription', async () => {
    expect(await store.seats(ids['acme']!)).toEqual([{ planCode: 'business', quantity: 4 }]);
    const sub = await store.subscription(ids['acme']!);
    expect(sub).toMatchObject({ billingCycle: 'monthly', lagoSubscriptionId: null });
    await store.setLagoSubscription(ids['acme']!, sub!.id, 'acme-monthly');
    expect((await store.subscription(ids['acme']!))?.lagoSubscriptionId).toBe('acme-monthly');
    expect((await store.subscription(ids['beta']!))?.lagoSubscriptionId).toBeNull();
    await store.addSeatSent(ids['acme']!, {
      metric: 'seats_business',
      seq: 1,
      delta: 4,
      unitsAfter: 4,
      transactionId: 'acme-seats_business-1',
      lagoSubscriptionId: 'acme-monthly',
      eventTs: new Date(),
      status: 'pending',
    });
    expect(await store.seatSent(ids['beta']!)).toEqual([]);
    expect((await store.seatSent(ids['acme']!))[0]?.delta).toBe(4);
  });

  it('lets one run at a time hold the lock', async () => {
    const other = new PgBillingStore(billingUrl);
    try {
      const inner = await store.exclusive(() => other.exclusive(async () => 'both'));
      expect(inner).toBeNull();
      expect(await other.exclusive(async () => 'alone')).toBe('alone');
    } finally {
      await other.close();
    }
  });

  it('reads the plans', async () => {
    expect(await store.plans()).toEqual([]);
  });
});
