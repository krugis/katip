// SPDX-License-Identifier: AGPL-3.0-only
// billing-bridge's data, as katip_billing: a role row-level security binds, so everything about
// one company is read and written in that company's context (LLD-05 §1).
import postgres from 'postgres';
import type { PlanRow, TokenClass } from './catalog.js';

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  kvkkAddon: boolean;
}

export interface SubscriptionRow {
  id: string;
  billingCycle: string;
  status: string;
  lagoSubscriptionId: string | null;
}

export interface UsageTotal {
  hour: Date;
  cls: TokenClass;
  tokens: number;
}

export interface UsageSentRow {
  hour: Date;
  cls: TokenClass;
  seq: number;
  tokens: number;
  transactionId: string;
  lagoSubscriptionId: string;
  eventTs: Date;
  status: 'pending' | 'sent';
}

export interface SeatSentRow {
  metric: string;
  seq: number;
  delta: number;
  unitsAfter: number;
  transactionId: string;
  lagoSubscriptionId: string;
  eventTs: Date;
  status: 'pending' | 'sent';
}

export interface BillingStore {
  plans(): Promise<PlanRow[]>;
  tenants(): Promise<TenantRow[]>;
  /** The company's one active subscription row, if any. */
  subscription(tenantId: string): Promise<SubscriptionRow | null>;
  setLagoSubscription(tenantId: string, subscriptionRowId: string, external: string): Promise<void>;
  seats(tenantId: string): Promise<{ planCode: string; quantity: number }[]>;
  /** Overage tokens per UTC hour and quota class, for hours in [from, to). */
  overageTotals(tenantId: string, from: Date, to: Date): Promise<UsageTotal[]>;
  /** Rows for hours from `from` on, and every pending one. */
  usageSent(tenantId: string, from: Date): Promise<UsageSentRow[]>;
  /** Fails if the row's key exists: another run got there first. */
  addUsageSent(tenantId: string, row: UsageSentRow): Promise<void>;
  markUsageSent(tenantId: string, transactionId: string, at: Date): Promise<void>;
  seatSent(tenantId: string): Promise<SeatSentRow[]>;
  addSeatSent(tenantId: string, row: SeatSentRow): Promise<void>;
  markSeatSent(tenantId: string, transactionId: string, at: Date): Promise<void>;
  /** Runs `fn` unless another run holds the lock; then returns null. */
  exclusive<T>(fn: () => Promise<T>): Promise<T | null>;
  close(): Promise<void>;
}

/** Any number, the same in every copy of billing-bridge, so two runs never overlap. */
const RUN_LOCK = 734_206_118;

const asClass = (c: string): TokenClass => (c === 'premium' ? 'premium' : 'standard');

export class PgBillingStore implements BillingStore {
  private readonly sql: postgres.Sql;

  constructor(databaseUrl: string) {
    this.sql = postgres(databaseUrl, { max: 2, prepare: false });
  }

  /** One transaction in the company's context: without it, RLS shows no rows. */
  private inTenant<T>(tenantId: string, fn: (tx: postgres.TransactionSql) => Promise<T>) {
    return this.sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  async plans() {
    const rows = await this.sql<{ code: string; version: number; monthly: string }[]>`
      select code, version, monthly_price_usd_micro as monthly from plans`;
    return rows.map((r) => ({
      code: r.code,
      version: r.version,
      monthlyPriceUsdMicro: Number(r.monthly),
    }));
  }

  async tenants() {
    const rows = await this.sql<TenantRow[]>`
      select id, slug, name, status, kvkk_addon as "kvkkAddon" from tenants order by slug`;
    return [...rows];
  }

  subscription(tenantId: string) {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<SubscriptionRow[]>`
        select id, billing_cycle as "billingCycle", status,
               lago_subscription_id as "lagoSubscriptionId"
        from subscriptions where tenant_id = ${tenantId} and status = 'active'
        order by lago_subscription_id nulls last, id limit 1`;
      return rows[0] ?? null;
    });
  }

  async setLagoSubscription(tenantId: string, subscriptionRowId: string, external: string) {
    await this.inTenant(
      tenantId,
      (tx) => tx`update subscriptions set lago_subscription_id = ${external}, updated_at = now()
        where tenant_id = ${tenantId} and id = ${subscriptionRowId}`,
    );
  }

  seats(tenantId: string) {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<{ planCode: string; quantity: number }[]>`
        select plan_code as "planCode", quantity from seats where tenant_id = ${tenantId}`;
      return [...rows];
    });
  }

  overageTotals(tenantId: string, from: Date, to: Date) {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<{ hour: Date; cls: string; tokens: string }[]>`
        select date_trunc('hour', ts, 'UTC') as hour,
               case when class = 'premium' then 'premium' else 'standard' end as cls,
               sum(input_tokens + output_tokens) as tokens
        from usage_events
        where tenant_id = ${tenantId} and overage and ts >= ${from} and ts < ${to}
        group by 1, 2`;
      return rows.map((r) => ({ hour: r.hour, cls: asClass(r.cls), tokens: Number(r.tokens) }));
    });
  }

  usageSent(tenantId: string, from: Date) {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<
        (Omit<UsageSentRow, 'cls' | 'tokens'> & { cls: string; tokens: string })[]
      >`
        select hour, class as cls, seq, tokens, transaction_id as "transactionId",
               lago_subscription_id as "lagoSubscriptionId", event_ts as "eventTs", status
        from billing_usage_sent
        where tenant_id = ${tenantId} and (hour >= ${from} or status = 'pending')`;
      return rows.map((r) => ({ ...r, cls: asClass(r.cls), tokens: Number(r.tokens) }));
    });
  }

  async addUsageSent(tenantId: string, r: UsageSentRow) {
    await this.inTenant(
      tenantId,
      (tx) => tx`insert into billing_usage_sent
        (tenant_id, hour, class, seq, tokens, transaction_id, lago_subscription_id, event_ts, status)
        values (${tenantId}, ${r.hour}, ${r.cls}, ${r.seq}, ${r.tokens}, ${r.transactionId},
                ${r.lagoSubscriptionId}, ${r.eventTs}, ${r.status})`,
    );
  }

  async markUsageSent(tenantId: string, transactionId: string, at: Date) {
    await this.inTenant(
      tenantId,
      (tx) => tx`update billing_usage_sent set status = 'sent', sent_at = ${at}
        where tenant_id = ${tenantId} and transaction_id = ${transactionId}`,
    );
  }

  seatSent(tenantId: string) {
    return this.inTenant(tenantId, async (tx) => {
      const rows = await tx<SeatSentRow[]>`
        select metric, seq, delta, units_after as "unitsAfter", transaction_id as "transactionId",
               lago_subscription_id as "lagoSubscriptionId", event_ts as "eventTs", status
        from billing_seat_sent where tenant_id = ${tenantId} order by metric, seq`;
      return [...rows];
    });
  }

  async addSeatSent(tenantId: string, r: SeatSentRow) {
    await this.inTenant(
      tenantId,
      (tx) => tx`insert into billing_seat_sent
        (tenant_id, metric, seq, delta, units_after, transaction_id, lago_subscription_id, event_ts, status)
        values (${tenantId}, ${r.metric}, ${r.seq}, ${r.delta}, ${r.unitsAfter}, ${r.transactionId},
                ${r.lagoSubscriptionId}, ${r.eventTs}, ${r.status})`,
    );
  }

  async markSeatSent(tenantId: string, transactionId: string, at: Date) {
    await this.inTenant(
      tenantId,
      (tx) => tx`update billing_seat_sent set status = 'sent', sent_at = ${at}
        where tenant_id = ${tenantId} and transaction_id = ${transactionId}`,
    );
  }

  async exclusive<T>(fn: () => Promise<T>): Promise<T | null> {
    const conn = await this.sql.reserve();
    try {
      const [got] = await conn<{ ok: boolean }[]>`select pg_try_advisory_lock(${RUN_LOCK}) as ok`;
      if (!got?.ok) return null;
      try {
        return await fn();
      } finally {
        await conn`select pg_advisory_unlock(${RUN_LOCK})`;
      }
    } finally {
      conn.release();
    }
  }

  async close() {
    await this.sql.end();
  }
}
