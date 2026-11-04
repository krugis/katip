// SPDX-License-Identifier: AGPL-3.0-only
// Stand-ins for Postgres and Lago, with Lago's behaviour as seen on getlago/api v1.55.0: an event
// whose transaction_id it has is refused with 422 value_already_exist, and a subscription is
// found by its external id.
import type { PlanRow } from '../src/catalog.js';
import {
  LagoError,
  type LagoApi,
  type LagoBillableMetric,
  type LagoCustomer,
  type LagoEvent,
  type LagoPlan,
  type LagoSubscription,
} from '../src/lago.js';
import type {
  BillingStore,
  SeatSentRow,
  SubscriptionRow,
  TenantRow,
  UsageSentRow,
} from '../src/store.js';

export interface UsageRow {
  tenantId: string;
  ts: Date;
  cls: string;
  tokens: number;
  overage: boolean;
}

export class MemoryStore implements BillingStore {
  tenantRows: TenantRow[] = [];
  subscriptions = new Map<string, SubscriptionRow>();
  seatRows = new Map<string, { planCode: string; quantity: number }[]>();
  usage: UsageRow[] = [];
  usageSentRows = new Map<string, UsageSentRow[]>();
  seatSentRows = new Map<string, SeatSentRow[]>();
  planRows: PlanRow[] = [];
  locked = false;

  addTenant(t: Partial<TenantRow> & { slug: string }, sub: Partial<SubscriptionRow> = {}) {
    const row: TenantRow = {
      id: `id-${t.slug}`,
      name: t.slug,
      status: 'active',
      kvkkAddon: false,
      ...t,
    };
    this.tenantRows.push(row);
    this.subscriptions.set(row.id, {
      id: `sub-${t.slug}`,
      billingCycle: 'monthly',
      status: 'active',
      lagoSubscriptionId: `${t.slug}-monthly`,
      ...sub,
    });
    return row;
  }

  addUsage(tenantId: string, ts: string, tokens: number, cls = 'standard', overage = true) {
    this.usage.push({ tenantId, ts: new Date(ts), cls, tokens, overage });
  }

  async plans() {
    return this.planRows;
  }
  async tenants() {
    return this.tenantRows;
  }
  async subscription(tenantId: string) {
    return this.subscriptions.get(tenantId) ?? null;
  }
  async setLagoSubscription(tenantId: string, _rowId: string, external: string) {
    const s = this.subscriptions.get(tenantId);
    if (s) s.lagoSubscriptionId = external;
  }
  async seats(tenantId: string) {
    return this.seatRows.get(tenantId) ?? [];
  }
  async overageTotals(tenantId: string, from: Date, to: Date) {
    const by = new Map<string, { hour: Date; cls: 'standard' | 'premium'; tokens: number }>();
    for (const u of this.usage) {
      if (u.tenantId !== tenantId || !u.overage || u.ts < from || u.ts >= to) continue;
      const hour = new Date(Math.floor(u.ts.getTime() / 3_600_000) * 3_600_000);
      const cls = u.cls === 'premium' ? 'premium' : 'standard';
      const k = `${hour.toISOString()}|${cls}`;
      const s = by.get(k) ?? { hour, cls, tokens: 0 };
      s.tokens += u.tokens;
      by.set(k, s);
    }
    return [...by.values()];
  }
  async usageSent(tenantId: string, from: Date) {
    return (this.usageSentRows.get(tenantId) ?? [])
      .filter((r) => r.hour >= from || r.status === 'pending')
      .map((r) => ({ ...r }));
  }
  async addUsageSent(tenantId: string, row: UsageSentRow) {
    const rows = this.usageSentRows.get(tenantId) ?? [];
    const clash = rows.some(
      (r) =>
        r.transactionId === row.transactionId ||
        (r.hour.getTime() === row.hour.getTime() && r.cls === row.cls && r.seq === row.seq),
    );
    if (clash) throw new Error('duplicate key value violates unique constraint');
    rows.push({ ...row });
    this.usageSentRows.set(tenantId, rows);
  }
  async markUsageSent(tenantId: string, transactionId: string) {
    for (const r of this.usageSentRows.get(tenantId) ?? []) {
      if (r.transactionId === transactionId) r.status = 'sent';
    }
  }
  async seatSent(tenantId: string) {
    return (this.seatSentRows.get(tenantId) ?? []).map((r) => ({ ...r }));
  }
  async addSeatSent(tenantId: string, row: SeatSentRow) {
    const rows = this.seatSentRows.get(tenantId) ?? [];
    if (rows.some((r) => r.transactionId === row.transactionId)) {
      throw new Error('duplicate key value violates unique constraint');
    }
    rows.push({ ...row });
    this.seatSentRows.set(tenantId, rows);
  }
  async markSeatSent(tenantId: string, transactionId: string) {
    for (const r of this.seatSentRows.get(tenantId) ?? []) {
      if (r.transactionId === transactionId) r.status = 'sent';
    }
  }
  async exclusive<T>(fn: () => Promise<T>) {
    if (this.locked) return null;
    this.locked = true;
    try {
      return await fn();
    } finally {
      this.locked = false;
    }
  }
  async close() {}
}

type Failure = 'down' | 'lost-ack';

export class FakeLago implements LagoApi {
  metrics = new Map<string, LagoBillableMetric>();
  plans = new Map<string, LagoPlan>();
  customers = new Map<string, LagoCustomer>();
  subs = new Map<string, LagoSubscription>();
  events = new Map<string, LagoEvent>();
  calls: LagoEvent[] = [];
  /** Fails the n-th sendEvent from now (1 = the next one) in the given way. */
  private failures = new Map<number, Failure>();
  private sendCount = 0;

  failEvent(nth: number, how: Failure) {
    this.failures.set(this.sendCount + nth, how);
  }

  addSubscription(external: string, customer: string, startedAt: string) {
    this.subs.set(external, {
      external_id: external,
      external_customer_id: customer,
      plan_code: 'katip_monthly',
      status: 'active',
      started_at: startedAt,
    });
  }

  /** What Lago would bill: the sum of a property over the events for a subscription and code. */
  billed(external: string, code: string, prop = 'tokens') {
    let n = 0;
    for (const e of this.events.values()) {
      if (e.external_subscription_id === external && e.code === code) n += e.properties[prop] ?? 0;
    }
    return n;
  }

  async getBillableMetric(code: string) {
    return this.metrics.get(code) ?? null;
  }
  async createBillableMetric(m: Omit<LagoBillableMetric, 'lago_id'>) {
    const r = { ...m, lago_id: `bm-${m.code}` };
    this.metrics.set(m.code, r);
    return r;
  }
  async getPlan(code: string) {
    return this.plans.get(code) ?? null;
  }
  async createPlan(p: LagoPlan) {
    const ids = new Map([...this.metrics.values()].map((m) => [m.lago_id, m.code]));
    const stored = {
      ...p,
      charges: p.charges.map(({ billable_metric_id, ...c }) => ({
        ...c,
        billable_metric_code: ids.get(billable_metric_id) ?? 'unknown',
      })),
    };
    this.plans.set(p.code, stored);
    return stored;
  }
  async upsertCustomer(c: LagoCustomer) {
    this.customers.set(c.external_id, c);
  }
  async createSubscription(s: Parameters<LagoApi['createSubscription']>[0]) {
    const have = this.subs.get(s.external_id);
    if (have) return have;
    const r = { ...s, status: 'active', started_at: s.subscription_at };
    this.subs.set(s.external_id, r);
    return r;
  }
  async getSubscription(external: string) {
    return this.subs.get(external) ?? null;
  }
  async sendEvent(e: LagoEvent) {
    this.sendCount++;
    this.calls.push(e);
    const failure = this.failures.get(this.sendCount);
    if (failure === 'down') throw new LagoError(503, 'service_unavailable');
    const key = `${e.external_subscription_id}|${e.transaction_id}`;
    if (this.events.has(key)) {
      throw new LagoError(422, 'validation_errors', { transaction_id: ['value_already_exist'] });
    }
    this.events.set(key, e);
    if (failure === 'lost-ack') throw new Error('fetch failed: socket hang up');
  }
  async currentUsage(_customer: string, external: string) {
    return {
      from_datetime: '2026-11-01T00:00:00Z',
      to_datetime: '2026-11-30T23:59:59Z',
      charges_usage: ['standard_tokens', 'premium_tokens'].map((code) => ({
        units: String(this.billed(external, code)),
        billable_metric: { code },
        amount_cents: 0,
      })),
    };
  }
}
