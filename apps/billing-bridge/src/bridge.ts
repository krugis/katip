// SPDX-License-Identifier: AGPL-3.0-only
// The hourly run (LLD-06 §1–2). Postgres is the source of truth: each run works out what Lago
// should have from usage_events and seats, compares it with what it recorded sending, and sends
// only the difference. A row is recorded as pending before its event goes, and marked sent once
// Lago has it, so a run that stops anywhere neither loses usage nor bills it twice:
//  - an event Lago got but whose row is still pending goes again with the same transaction_id,
//    and Lago refuses it as a duplicate, which counts as sent;
//  - usage arriving after its hour went (the gateway's Valkey outbox can hold events back) is
//    sent as one more event for that hour, for the difference, under the next transaction_id;
//  - each hour waits `graceMinutes` after it ends before it's sent, so most usage is in by then.
import type { Logger } from '@katip/shared';
import { KVKK_SEATS, MONTHLY_PLAN, TOKEN_METRIC, type TokenClass } from './catalog.js';
import { isDuplicateEvent, type LagoApi, type LagoEvent } from './lago.js';
import type { BillingStore, SeatSentRow, TenantRow, UsageSentRow } from './store.js';

const HOUR_MS = 3_600_000;

export interface BridgeSettings {
  /** Minutes after an hour ends before it's sent. */
  graceMinutes: number;
  /** How far back each run looks for usage that arrived late. */
  lookbackDays: number;
  /** Seat metric by plan code, from the catalog. */
  seatMetrics: Record<string, string>;
  /** The KVKK add-on's seat metric, if the catalog has one. */
  kvkkMetric: string | null;
}

export interface BridgeDeps {
  store: BillingStore;
  lago: LagoApi;
  now: () => Date;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  settings: BridgeSettings;
}

export const floorHour = (d: Date) => new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);

/** 2026110410 for 10:00–11:00 UTC on 4 November 2026. */
export const hourKey = (hour: Date) => hour.toISOString().slice(0, 13).replace(/[-T]/g, '');

/** `<tenant>-<hour>-<class>` (LLD-06 §2); a later event for the same hour adds `-<seq>`. */
export const usageTransactionId = (slug: string, hour: Date, cls: TokenClass, seq: number) =>
  `${slug}-${hourKey(hour)}-${cls}${seq === 0 ? '' : `-${seq}`}`;

export const seatTransactionId = (slug: string, metric: string, seq: number) =>
  `${slug}-${metric}-${seq}`;

const sameUtcMonth = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();

/**
 * Where the event goes in Lago's time, which decides its invoice. Its own hour while that month
 * is still open. Once the month is over, Lago may have invoiced it, and it would ignore an event
 * dated then, so the usage goes on the current month's invoice instead.
 */
export const eventTime = (hour: Date, now: Date) => (sameUtcMonth(hour, now) ? hour : now);

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export interface TenantResult {
  slug: string;
  usageEvents: number;
  seatEvents: number;
}

export interface RunResult {
  tenants: TenantResult[];
  skipped: { slug: string; reason: string }[];
  errors: { slug: string; error: string }[];
}

/** Sends one event, as recorded: a duplicate means Lago has it already. */
async function deliver(lago: LagoApi, event: LagoEvent): Promise<void> {
  try {
    await lago.sendEvent(event);
  } catch (e) {
    if (!isDuplicateEvent(e)) throw e;
  }
}

const usageEvent = (r: UsageSentRow): LagoEvent => ({
  transaction_id: r.transactionId,
  external_subscription_id: r.lagoSubscriptionId,
  code: TOKEN_METRIC[r.cls],
  timestamp: unix(r.eventTs),
  properties: { tokens: r.tokens },
});

const seatEvent = (r: SeatSentRow): LagoEvent => ({
  transaction_id: r.transactionId,
  external_subscription_id: r.lagoSubscriptionId,
  code: r.metric,
  timestamp: unix(r.eventTs),
  properties: { seats: r.delta },
});

/** What Lago should count for each seat metric: seats bought per plan, and the KVKK add-on. */
export function wantedSeats(
  seats: { planCode: string; quantity: number }[],
  kvkkAddon: boolean,
  seatMetrics: Record<string, string>,
  kvkkMetric: string | null = KVKK_SEATS,
): Record<string, number> {
  const want: Record<string, number> = {};
  let total = 0;
  for (const metric of Object.values(seatMetrics)) want[metric] = 0;
  for (const s of seats) {
    const metric = seatMetrics[s.planCode];
    if (!metric) continue;
    want[metric] = (want[metric] ?? 0) + s.quantity;
    total += s.quantity;
  }
  if (kvkkMetric) want[kvkkMetric] = kvkkAddon ? total : 0;
  return want;
}

async function syncSeats(deps: BridgeDeps, t: TenantRow, subscription: string): Promise<number> {
  const { store, lago, now, settings } = deps;
  const sent = await store.seatSent(t.id);
  const want = wantedSeats(
    await store.seats(t.id),
    t.kvkkAddon,
    settings.seatMetrics,
    settings.kvkkMetric,
  );
  let events = 0;
  for (const [metric, units] of Object.entries(want)) {
    const rows = sent.filter((r) => r.metric === metric);
    // Seats are counted per Lago subscription: a new one starts from none.
    const last = rows.filter((r) => r.lagoSubscriptionId === subscription).at(-1);
    const have = last?.unitsAfter ?? 0;
    if (units === have) continue;
    const seq = (rows.at(-1)?.seq ?? 0) + 1;
    const row: SeatSentRow = {
      metric,
      seq,
      delta: units - have,
      unitsAfter: units,
      transactionId: seatTransactionId(t.slug, metric, seq),
      lagoSubscriptionId: subscription,
      eventTs: now(),
      status: 'pending',
    };
    await store.addSeatSent(t.id, row);
    await deliver(lago, seatEvent(row));
    await store.markSeatSent(t.id, row.transactionId, now());
    events++;
  }
  return events;
}

async function sendUsage(
  deps: BridgeDeps,
  t: TenantRow,
  subscription: string,
  startedAt: Date,
): Promise<number> {
  const { store, lago, now, settings, log } = deps;
  const at = now();
  const closedBefore = floorHour(new Date(at.getTime() - settings.graceMinutes * 60_000));
  const lookback = floorHour(new Date(at.getTime() - settings.lookbackDays * 24 * HOUR_MS));
  // Lago doesn't bill an event from before its subscription began.
  const from = new Date(Math.max(lookback.getTime(), floorHour(startedAt).getTime()));
  if (from >= closedBefore) return 0;

  const sent = await store.usageSent(t.id, from);
  const key = (hour: Date, cls: string) => `${hour.toISOString()}|${cls}`;
  const sentBy = new Map<string, { tokens: number; seq: number }>();
  for (const r of sent) {
    const k = key(r.hour, r.cls);
    const s = sentBy.get(k) ?? { tokens: 0, seq: -1 };
    sentBy.set(k, { tokens: s.tokens + r.tokens, seq: Math.max(s.seq, r.seq) });
  }

  const totals = (await store.overageTotals(t.id, from, closedBefore)).sort(
    (a, b) => a.hour.getTime() - b.hour.getTime() || a.cls.localeCompare(b.cls),
  );
  // An hour that was billed and now has no usage at all still has to be noticed.
  const seen = new Set(totals.map((x) => key(x.hour, x.cls)));
  for (const r of sent) {
    if (r.hour < closedBefore && !seen.has(key(r.hour, r.cls))) {
      seen.add(key(r.hour, r.cls));
      totals.push({ hour: r.hour, cls: r.cls, tokens: 0 });
    }
  }
  let events = 0;
  for (const total of totals) {
    const s = sentBy.get(key(total.hour, total.cls)) ?? { tokens: 0, seq: -1 };
    if (total.tokens < s.tokens) {
      // Only if events were deleted after being billed. Nothing can be taken back here.
      log.warn(
        { tenant_id: t.id, hour: hourKey(total.hour), class: total.cls },
        'usage is now below what was billed for this hour',
      );
      continue;
    }
    if (total.tokens === s.tokens) continue;
    const seq = s.seq + 1;
    const row: UsageSentRow = {
      hour: total.hour,
      cls: total.cls,
      seq,
      tokens: total.tokens - s.tokens,
      transactionId: usageTransactionId(t.slug, total.hour, total.cls, seq),
      lagoSubscriptionId: subscription,
      eventTs: eventTime(total.hour, at),
      status: 'pending',
    };
    await store.addUsageSent(t.id, row);
    await deliver(lago, usageEvent(row));
    await store.markUsageSent(t.id, row.transactionId, now());
    events++;
  }
  return events;
}

/** Events recorded but not confirmed: the last run stopped before Lago answered. */
async function resendPending(deps: BridgeDeps, t: TenantRow): Promise<number> {
  const { store, lago, now } = deps;
  let events = 0;
  for (const r of (await store.seatSent(t.id)).filter((x) => x.status === 'pending')) {
    await deliver(lago, seatEvent(r));
    await store.markSeatSent(t.id, r.transactionId, now());
    events++;
  }
  const pending = (await store.usageSent(t.id, now())).filter((x) => x.status === 'pending');
  for (const r of pending) {
    await deliver(lago, usageEvent(r));
    await store.markUsageSent(t.id, r.transactionId, now());
    events++;
  }
  return events;
}

/** One company: what was left pending, then seats, then usage. */
export async function runTenant(deps: BridgeDeps, t: TenantRow): Promise<TenantResult | string> {
  const sub = await deps.store.subscription(t.id);
  if (!sub?.lagoSubscriptionId) return 'not attached to Lago';
  const external = sub.lagoSubscriptionId;
  const resent = await resendPending(deps, t);
  const inLago = await deps.lago.getSubscription(external);
  if (!inLago) throw new Error(`subscription ${external} is not in Lago`);
  if (inLago.status && inLago.status !== 'active') return `Lago subscription is ${inLago.status}`;
  const startedAt = inLago.started_at ? new Date(inLago.started_at) : deps.now();
  const seatEvents = await syncSeats(deps, t, external);
  const usageEvents = await sendUsage(deps, t, external, startedAt);
  return { slug: t.slug, usageEvents: usageEvents + resent, seatEvents };
}

/** Every company once. One that fails doesn't stop the others; the next run picks it up. */
export async function runOnce(deps: BridgeDeps): Promise<RunResult | null> {
  return deps.store.exclusive(async () => {
    const result: RunResult = { tenants: [], skipped: [], errors: [] };
    for (const t of await deps.store.tenants()) {
      // A suspended or deleted company makes no new usage. What its subscription does then is
      // the owner's decision (LLD-06), so it's left as it is.
      if (t.status !== 'active') {
        result.skipped.push({ slug: t.slug, reason: t.status });
        continue;
      }
      try {
        const r = await runTenant(deps, t);
        if (typeof r === 'string') result.skipped.push({ slug: t.slug, reason: r });
        else result.tenants.push(r);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        result.errors.push({ slug: t.slug, error });
        deps.log.error({ tenant_id: t.id, err: error }, 'billing run failed for this company');
      }
    }
    return result;
  });
}

export interface AttachOptions {
  /** Where Lago sends invoices. Leave out for none. */
  email?: string;
  /** When billing begins, if not this hour: usage from then on is billed. */
  since?: Date;
}

/**
 * Gives a company its Lago customer and subscription, and records it, so runs start billing it.
 * A provider action: nothing attaches a company by itself. Safe to repeat.
 */
export async function attachTenant(
  deps: Pick<BridgeDeps, 'store' | 'lago' | 'now'>,
  slug: string,
  opts: AttachOptions = {},
): Promise<{ subscription: string }> {
  const t = (await deps.store.tenants()).find((x) => x.slug === slug);
  if (!t) throw new Error(`no company ${slug}`);
  if (t.status !== 'active') throw new Error(`company ${slug} is ${t.status}`);
  const sub = await deps.store.subscription(t.id);
  if (!sub) throw new Error(`company ${slug} has no active subscription row`);
  // Only the monthly plan is set up: how an annual plan is invoiced is the owner's decision.
  if (sub.billingCycle !== 'monthly') {
    throw new Error(`company ${slug} is billed ${sub.billingCycle}, and only monthly is set up`);
  }
  const external = sub.lagoSubscriptionId ?? `${slug}-monthly`;
  await deps.lago.upsertCustomer({
    external_id: slug,
    name: t.name,
    currency: 'USD',
    timezone: 'UTC',
    ...(opts.email ? { email: opts.email } : {}),
  });
  await deps.lago.createSubscription({
    external_customer_id: slug,
    plan_code: MONTHLY_PLAN,
    external_id: external,
    billing_time: 'calendar',
    // From the start of the hour, so that hour's usage is billed too. Lago keeps the first value.
    subscription_at: floorHour(opts.since ?? deps.now()).toISOString(),
  });
  if (sub.lagoSubscriptionId !== external) {
    await deps.store.setLagoSubscription(t.id, sub.id, external);
  }
  return { subscription: external };
}
