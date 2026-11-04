// SPDX-License-Identifier: AGPL-3.0-only
// P1-37: hourly overage and seats to Lago. Replays, late usage, empty hours, seat changes and a
// Lago failure in the middle of a run must neither lose usage nor bill it twice.
import { describe, expect, it } from 'vitest';
import {
  attachTenant,
  eventTime,
  hourKey,
  runOnce,
  usageTransactionId,
  wantedSeats,
  type BridgeDeps,
} from '../src/bridge.js';
import { reconcileTenant, withinTolerance } from '../src/reconcile.js';
import { FakeLago, MemoryStore } from './fakes.js';

const SEATS = { starter: 'seats_starter', business: 'seats_business', studio: 'seats_studio' };

function setup(now = '2026-11-04T12:20:00Z') {
  const store = new MemoryStore();
  const lago = new FakeLago();
  const clock = { now: new Date(now) };
  const warnings: string[] = [];
  const deps: BridgeDeps = {
    store,
    lago,
    now: () => clock.now,
    log: {
      info: () => {},
      warn: (_o: unknown, m?: string) => warnings.push(String(m)),
      error: () => {},
    } as BridgeDeps['log'],
    settings: {
      graceMinutes: 10,
      lookbackDays: 35,
      seatMetrics: SEATS,
      kvkkMetric: 'kvkk_seats',
    },
  };
  const acme = store.addTenant({ slug: 'acme', name: 'Acme Ltd.' });
  store.seatRows.set(acme.id, [{ planCode: 'business', quantity: 10 }]);
  lago.addSubscription('acme-monthly', 'acme', '2026-11-01T00:00:00Z');
  return { store, lago, clock, deps, acme, warnings };
}

const at = (clock: { now: Date }, iso: string) => {
  clock.now = new Date(iso);
};

describe('hours and ids', () => {
  it('names an hour and its events as LLD-06 §2 does', () => {
    const h = new Date('2026-11-04T10:00:00Z');
    expect(hourKey(h)).toBe('2026110410');
    expect(usageTransactionId('acme', h, 'standard', 0)).toBe('acme-2026110410-standard');
    expect(usageTransactionId('acme', h, 'premium', 2)).toBe('acme-2026110410-premium-2');
  });

  it("dates an event in its own hour, unless that hour's month is over", () => {
    const now = new Date('2026-12-01T00:15:00Z');
    expect(eventTime(new Date('2026-12-01T00:00:00Z'), now)).toEqual(
      new Date('2026-12-01T00:00:00Z'),
    );
    expect(eventTime(new Date('2026-11-30T23:00:00Z'), now)).toEqual(now);
  });

  it('counts seats per plan, and the KVKK add-on for all of them', () => {
    const seats = [
      { planCode: 'business', quantity: 8 },
      { planCode: 'studio', quantity: 2 },
      { planCode: 'community', quantity: 3 },
    ];
    expect(wantedSeats(seats, true, SEATS)).toEqual({
      seats_starter: 0,
      seats_business: 8,
      seats_studio: 2,
      kvkk_seats: 10,
    });
    expect(wantedSeats(seats, false, SEATS, null)).toEqual({
      seats_starter: 0,
      seats_business: 8,
      seats_studio: 2,
    });
  });
});

describe('usage', () => {
  it('sends each closed hour and class once, with its total, and waits for the grace period', async () => {
    const { store, lago, deps, acme } = setup('2026-11-04T12:05:00Z');
    store.addUsage(acme.id, '2026-11-04T10:10:00Z', 1_000);
    store.addUsage(acme.id, '2026-11-04T10:50:00Z', 500);
    store.addUsage(acme.id, '2026-11-04T10:20:00Z', 70, 'premium');
    store.addUsage(acme.id, '2026-11-04T10:30:00Z', 30, 'tr'); // counted as standard, as quota does
    store.addUsage(acme.id, '2026-11-04T10:40:00Z', 9_999, 'standard', false); // within quota
    store.addUsage(acme.id, '2026-11-04T11:30:00Z', 200); // 11:00 ended 5 min ago: not yet

    const r = await runOnce(deps);
    expect(r?.errors).toEqual([]);
    const sent = lago.calls.filter((e) => e.code.endsWith('_tokens'));
    expect(sent.map((e) => [e.transaction_id, e.code, e.properties['tokens']])).toEqual([
      ['acme-2026110410-premium', 'premium_tokens', 70],
      ['acme-2026110410-standard', 'standard_tokens', 1_530],
    ]);
    expect(sent[0]!.external_subscription_id).toBe('acme-monthly');
    expect(sent[0]!.timestamp).toBe(Date.parse('2026-11-04T10:00:00Z') / 1000);
    expect(store.usageSentRows.get(acme.id)!.every((x) => x.status === 'sent')).toBe(true);
  });

  it('sends nothing for an hour with nothing in it, and nothing again on a second run', async () => {
    const { store, lago, deps, acme } = setup();
    store.addUsage(acme.id, '2026-11-04T09:15:00Z', 100);
    await runOnce(deps);
    const before = lago.calls.length;
    await runOnce(deps);
    expect(lago.calls.length).toBe(before);
    // 10:00 and 11:00 had nothing: one event in all, for 09:00.
    expect(lago.calls.filter((e) => e.code === 'standard_tokens')).toHaveLength(1);
    expect(store.usageSentRows.get(acme.id)).toHaveLength(1);
  });

  it('a replay of every event bills nothing twice', async () => {
    const { store, lago, deps, acme } = setup();
    store.addUsage(acme.id, '2026-11-04T09:15:00Z', 100);
    store.addUsage(acme.id, '2026-11-04T10:15:00Z', 40, 'premium');
    await runOnce(deps);
    // As if every answer had been lost: all rows pending again, so all go again.
    for (const row of store.usageSentRows.get(acme.id)!) row.status = 'pending';
    for (const row of store.seatSentRows.get(acme.id)!) row.status = 'pending';
    const r = await runOnce(deps);
    expect(r?.errors).toEqual([]);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(100);
    expect(lago.billed('acme-monthly', 'premium_tokens')).toBe(40);
    expect(lago.billed('acme-monthly', 'seats_business', 'seats')).toBe(10);
    expect(store.usageSentRows.get(acme.id)!.every((x) => x.status === 'sent')).toBe(true);
  });

  it('sends usage that arrives late for a sent hour as one more event, for the difference', async () => {
    const { store, lago, deps, acme, clock } = setup();
    store.addUsage(acme.id, '2026-11-04T10:15:00Z', 100);
    await runOnce(deps);
    // The gateway's outbox delivers more usage for 10:00 after it went.
    store.addUsage(acme.id, '2026-11-04T10:59:59Z', 25);
    at(clock, '2026-11-04T13:20:00Z');
    await runOnce(deps);
    const ids = lago.calls.filter((e) => e.code === 'standard_tokens').map((e) => e.transaction_id);
    expect(ids).toEqual(['acme-2026110410-standard', 'acme-2026110410-standard-1']);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(125);
    expect(lago.calls.at(-1)!.timestamp).toBe(Date.parse('2026-11-04T10:00:00Z') / 1000);
  });

  it("puts late usage from a month that's over on the current month's invoice", async () => {
    const { store, lago, deps, acme } = setup('2026-12-01T03:00:00Z');
    store.addUsage(acme.id, '2026-11-30T23:40:00Z', 300);
    await runOnce(deps);
    const e = lago.calls.find((x) => x.code === 'standard_tokens')!;
    expect(e.transaction_id).toBe('acme-2026113023-standard');
    expect(e.timestamp).toBe(Date.parse('2026-12-01T03:00:00Z') / 1000);
  });

  it("doesn't send usage from before the subscription began", async () => {
    const { store, lago, deps, acme } = setup();
    lago.subs.get('acme-monthly')!.started_at = '2026-11-04T10:00:00Z';
    store.addUsage(acme.id, '2026-11-04T09:30:00Z', 999);
    store.addUsage(acme.id, '2026-11-04T10:30:00Z', 1);
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(1);
  });

  it('warns, and takes nothing back, when usage falls below what was billed', async () => {
    const { store, lago, deps, acme, warnings } = setup();
    store.addUsage(acme.id, '2026-11-04T10:15:00Z', 100);
    await runOnce(deps);
    store.usage = [];
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(100);
    expect(warnings).toContain('usage is now below what was billed for this hour');
  });
});

describe('seats', () => {
  it('sends each change of seats as the difference, and nothing when they stay', async () => {
    const { store, lago, deps, acme } = setup();
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'seats_business', 'seats')).toBe(10);
    store.seatRows.set(acme.id, [
      { planCode: 'business', quantity: 12 },
      { planCode: 'studio', quantity: 2 },
    ]);
    await runOnce(deps);
    store.seatRows.set(acme.id, [
      { planCode: 'business', quantity: 8 },
      { planCode: 'studio', quantity: 2 },
    ]);
    await runOnce(deps);
    const calls = lago.calls.length;
    await runOnce(deps);
    expect(lago.calls.length).toBe(calls);

    const business = lago.calls.filter((e) => e.code === 'seats_business');
    expect(business.map((e) => [e.transaction_id, e.properties['seats']])).toEqual([
      ['acme-seats_business-1', 10],
      ['acme-seats_business-2', 2],
      ['acme-seats_business-3', -4],
    ]);
    expect(lago.billed('acme-monthly', 'seats_business', 'seats')).toBe(8);
    expect(lago.billed('acme-monthly', 'seats_studio', 'seats')).toBe(2);
  });

  it('starts a new Lago subscription from no seats', async () => {
    const { store, lago, deps, acme } = setup();
    await runOnce(deps);
    store.subscriptions.get(acme.id)!.lagoSubscriptionId = 'acme-other';
    lago.addSubscription('acme-other', 'acme', '2026-11-04T12:00:00Z');
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'seats_business', 'seats')).toBe(10);
    expect(lago.billed('acme-other', 'seats_business', 'seats')).toBe(10);
    expect(lago.calls.at(-1)?.transaction_id).toBe('acme-seats_business-2');
  });

  it('counts the KVKK add-on for every seat while the company has it', async () => {
    const { store, lago, deps, acme } = setup();
    acme.kvkkAddon = true;
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'kvkk_seats', 'seats')).toBe(10);
    acme.kvkkAddon = false;
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'kvkk_seats', 'seats')).toBe(0);
    expect(store.seatSentRows.get(acme.id)!.filter((r) => r.metric === 'kvkk_seats')).toHaveLength(
      2,
    );
  });
});

describe('when Lago fails', () => {
  it('in the middle of a run: the rest goes on the next run, and nothing goes twice', async () => {
    const { store, lago, deps, acme } = setup();
    store.addUsage(acme.id, '2026-11-04T09:15:00Z', 100);
    store.addUsage(acme.id, '2026-11-04T10:15:00Z', 200);
    store.addUsage(acme.id, '2026-11-04T11:15:00Z', 300);
    // Seats go first, then 09:00; 10:00 finds Lago down.
    lago.failEvent(3, 'down');
    const first = await runOnce(deps);
    expect(first?.errors.map((e) => e.slug)).toEqual(['acme']);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(100);
    const rows = store.usageSentRows.get(acme.id)!;
    expect(rows.map((r) => r.status)).toEqual(['sent', 'pending']);

    const second = await runOnce(deps);
    expect(second?.errors).toEqual([]);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(600);
    expect(store.usageSentRows.get(acme.id)!.every((x) => x.status === 'sent')).toBe(true);
  });

  it('when Lago took an event but the answer was lost, the resend counts as sent', async () => {
    const { store, lago, deps, acme } = setup();
    store.addUsage(acme.id, '2026-11-04T10:15:00Z', 100);
    lago.failEvent(2, 'lost-ack');
    const first = await runOnce(deps);
    expect(first?.errors).toHaveLength(1);
    expect(store.usageSentRows.get(acme.id)![0]!.status).toBe('pending');
    await runOnce(deps);
    expect(lago.billed('acme-monthly', 'standard_tokens')).toBe(100);
    expect(store.usageSentRows.get(acme.id)![0]!.status).toBe('sent');
  });

  it("one company's failure doesn't stop the others", async () => {
    const { store, lago, deps } = setup();
    const beta = store.addTenant({ slug: 'beta' });
    store.seatRows.set(beta.id, [{ planCode: 'starter', quantity: 3 }]);
    lago.addSubscription('beta-monthly', 'beta', '2026-11-01T00:00:00Z');
    lago.subs.delete('acme-monthly');
    const r = await runOnce(deps);
    expect(r?.errors).toEqual([
      { slug: 'acme', error: 'subscription acme-monthly is not in Lago' },
    ]);
    expect(lago.billed('beta-monthly', 'seats_starter', 'seats')).toBe(3);
  });
});

describe('which companies', () => {
  it('skips one not attached to Lago, and one not active', async () => {
    const { store, lago, deps } = setup();
    store.addTenant({ slug: 'loose' }, { lagoSubscriptionId: null });
    store.addTenant({ slug: 'gone', status: 'suspended' });
    const r = await runOnce(deps);
    expect(r?.skipped).toEqual([
      { slug: 'loose', reason: 'not attached to Lago' },
      { slug: 'gone', reason: 'suspended' },
    ]);
    expect(lago.calls.every((e) => e.external_subscription_id === 'acme-monthly')).toBe(true);
  });

  it('runs once at a time', async () => {
    const { store, deps } = setup();
    store.locked = true;
    expect(await runOnce(deps)).toBeNull();
  });

  it('attaches a company once, however often it is asked, and only on the monthly plan', async () => {
    const { store, lago, deps } = setup();
    const t = store.addTenant({ slug: 'newco', name: 'NewCo A.Ş.' }, { lagoSubscriptionId: null });
    expect(await attachTenant(deps, 'newco')).toEqual({ subscription: 'newco-monthly' });
    expect(await attachTenant(deps, 'newco')).toEqual({ subscription: 'newco-monthly' });
    expect(store.subscriptions.get(t.id)!.lagoSubscriptionId).toBe('newco-monthly');
    expect(lago.customers.get('newco')).toMatchObject({ name: 'NewCo A.Ş.', currency: 'USD' });
    expect(lago.subs.get('newco-monthly')!.started_at).toBe('2026-11-04T12:00:00.000Z');

    store.addTenant({ slug: 'yearly' }, { lagoSubscriptionId: null, billingCycle: 'annual' });
    await expect(attachTenant(deps, 'yearly')).rejects.toThrow(/only monthly is set up/);
    await expect(attachTenant(deps, 'nobody')).rejects.toThrow(/no company/);
  });
});

describe('reconciliation', () => {
  it('matches when every closed hour is sent, and says where it does not', async () => {
    const { store, deps, acme, clock } = setup();
    store.addUsage(acme.id, '2026-11-04T09:15:00Z', 1_000_000);
    store.addUsage(acme.id, '2026-11-04T10:15:00Z', 7, 'premium');
    await runOnce(deps);
    const ok = await reconcileTenant(deps, acme);
    expect(ok?.ok).toBe(true);
    expect(ok?.classes.find((c) => c.cls === 'standard')).toMatchObject({
      usage: 1_000_000,
      sentForHours: 1_000_000,
      sentInPeriod: 1_000_000,
      lago: 1_000_000,
    });

    store.addUsage(acme.id, '2026-11-04T11:15:00Z', 5);
    at(clock, '2026-11-04T12:30:00Z');
    const behind = await reconcileTenant(deps, acme);
    expect(behind?.ok).toBe(false);
    expect(behind?.classes.find((c) => c.cls === 'standard')?.usage).toBe(1_000_005);
  });

  it('allows 0.1% and no more', () => {
    expect(withinTolerance(1_000_000, 1_000_999)).toBe(true);
    expect(withinTolerance(1_000_000, 1_002_000)).toBe(false);
    expect(withinTolerance(0, 0)).toBe(true);
  });
});
