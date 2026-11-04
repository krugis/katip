// SPDX-License-Identifier: AGPL-3.0-only
// The check of LLD-06 §7: overage in usage_events matches what Lago bills, within 0.1%. It is
// two comparisons, so a difference says where it is: usage_events against what was sent for the
// same hours, which must be exact once those hours are sent, and what was sent into Lago's
// current billing period against Lago's own count for it.
import { TOKEN_METRIC, type TokenClass } from './catalog.js';
import { floorHour, type BridgeDeps } from './bridge.js';
import type { TenantRow } from './store.js';

export const TOLERANCE = 0.001;

export const withinTolerance = (a: number, b: number, tolerance = TOLERANCE) =>
  Math.abs(a - b) <= tolerance * Math.max(Math.abs(a), Math.abs(b));

export interface ClassReconciliation {
  cls: TokenClass;
  /** Overage tokens in usage_events, for this month's closed hours since the subscription began. */
  usage: number;
  /** What was recorded as sent for those hours. */
  sentForHours: number;
  /** Sent events dated inside Lago's current billing period. */
  sentInPeriod: number;
  /** Lago's units for the metric in its current billing period. */
  lago: number;
  ok: boolean;
}

export interface Reconciliation {
  slug: string;
  period: { from: string; to: string };
  classes: ClassReconciliation[];
  ok: boolean;
}

export async function reconcileTenant(
  deps: BridgeDeps,
  t: TenantRow,
): Promise<Reconciliation | null> {
  const { store, lago, now, settings } = deps;
  const sub = await store.subscription(t.id);
  if (!sub?.lagoSubscriptionId) return null;
  const inLago = await lago.getSubscription(sub.lagoSubscriptionId);
  if (!inLago) throw new Error(`subscription ${sub.lagoSubscriptionId} is not in Lago`);
  const at = now();
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const started = floorHour(inLago.started_at ? new Date(inLago.started_at) : at);
  const from = started > monthStart ? started : monthStart;
  const closedBefore = floorHour(new Date(at.getTime() - settings.graceMinutes * 60_000));

  const usage = await lago.currentUsage(t.slug, sub.lagoSubscriptionId);
  const periodFrom = new Date(usage.from_datetime);
  const periodTo = new Date(usage.to_datetime);
  const totals = closedBefore > from ? await store.overageTotals(t.id, from, closedBefore) : [];
  const lookback = new Date(monthStart.getTime() - settings.lookbackDays * 86_400_000);
  const sent = await store.usageSent(t.id, lookback);

  const classes = (Object.keys(TOKEN_METRIC) as TokenClass[]).map((cls) => {
    const sum = (xs: { tokens: number }[]) => xs.reduce((n, x) => n + x.tokens, 0);
    const mine = sent.filter((r) => r.cls === cls);
    const row: Omit<ClassReconciliation, 'ok'> = {
      cls,
      usage: sum(totals.filter((x) => x.cls === cls)),
      sentForHours: sum(mine.filter((r) => r.hour >= from && r.hour < closedBefore)),
      sentInPeriod: sum(
        mine.filter((r) => r.status === 'sent' && r.eventTs >= periodFrom && r.eventTs <= periodTo),
      ),
      lago: Number(
        usage.charges_usage.find((c) => c.billable_metric.code === TOKEN_METRIC[cls])?.units ?? 0,
      ),
    };
    return {
      ...row,
      ok: row.usage === row.sentForHours && withinTolerance(row.sentInPeriod, row.lago),
    };
  });
  return {
    slug: t.slug,
    period: { from: usage.from_datetime, to: usage.to_datetime },
    classes,
    ok: classes.every((c) => c.ok),
  };
}
