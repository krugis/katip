// SPDX-License-Identifier: AGPL-3.0-only
// The part of Lago's REST API (v1, as in getlago/api v1.55.0) that billing-bridge uses. Field
// names were checked against that version's controllers and by calls to it (P1-36).

/** A Lago answer other than 2xx. `code` and `details` are Lago's own. */
export class LagoError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(`Lago answered ${status} ${code}`);
    this.name = 'LagoError';
  }
}

/** Lago refuses an event whose transaction_id it already has: that event is in, once. */
export const isDuplicateEvent = (e: unknown): boolean => {
  if (!(e instanceof LagoError) || e.status !== 422) return false;
  const tx = e.details['transaction_id'];
  return Array.isArray(tx) && tx.includes('value_already_exist');
};

export const isNotFound = (e: unknown): boolean => e instanceof LagoError && e.status === 404;

export interface LagoEvent {
  transaction_id: string;
  external_subscription_id: string;
  code: string;
  /** Unix seconds. */
  timestamp: number;
  properties: Record<string, number>;
}

export interface LagoBillableMetric {
  code: string;
  name: string;
  aggregation_type: string;
  field_name: string | null;
  recurring: boolean;
  lago_id?: string;
}

export interface LagoCharge {
  code: string;
  billable_metric_code?: string;
  lago_billable_metric_id?: string;
  billable_metric_id?: string;
  charge_model: 'standard';
  pay_in_advance: boolean;
  prorated: boolean;
  invoice_display_name?: string;
  properties: { amount: string };
}

export interface LagoPlan {
  code: string;
  name: string;
  interval: 'monthly' | 'yearly';
  amount_cents: number;
  amount_currency: string;
  pay_in_advance: boolean;
  charges: LagoCharge[];
}

export interface LagoCustomer {
  external_id: string;
  name: string;
  currency: string;
  timezone: string;
  email?: string;
}

export interface LagoSubscription {
  external_id: string;
  external_customer_id: string;
  plan_code: string;
  status?: string;
  started_at?: string | null;
}

export interface LagoUsage {
  from_datetime: string;
  to_datetime: string;
  charges_usage: { units: string; billable_metric: { code: string }; amount_cents: number }[];
}

/** What billing-bridge needs from Lago, so tests can stand in for it. */
export interface LagoApi {
  getBillableMetric(code: string): Promise<LagoBillableMetric | null>;
  createBillableMetric(m: Omit<LagoBillableMetric, 'lago_id'>): Promise<LagoBillableMetric>;
  getPlan(code: string): Promise<LagoPlan | null>;
  createPlan(p: LagoPlan): Promise<LagoPlan>;
  upsertCustomer(c: LagoCustomer): Promise<void>;
  createSubscription(
    s: Omit<LagoSubscription, 'status' | 'started_at'> & {
      billing_time: 'calendar';
      subscription_at: string;
    },
  ): Promise<LagoSubscription>;
  getSubscription(externalId: string): Promise<LagoSubscription | null>;
  sendEvent(e: LagoEvent): Promise<void>;
  currentUsage(externalCustomerId: string, externalSubscriptionId: string): Promise<LagoUsage>;
}

export class LagoClient implements LagoApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15_000,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (!res.ok) {
      throw new LagoError(
        res.status,
        String(json['code'] ?? json['error'] ?? 'error'),
        (json['error_details'] as Record<string, unknown> | undefined) ?? {},
      );
    }
    return json as T;
  }

  private async orNull<T>(p: Promise<T>): Promise<T | null> {
    try {
      return await p;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async getBillableMetric(code: string) {
    const r = await this.orNull(
      this.call<{ billable_metric: LagoBillableMetric }>(
        'GET',
        `/billable_metrics/${encodeURIComponent(code)}`,
      ),
    );
    return r?.billable_metric ?? null;
  }

  async createBillableMetric(m: Omit<LagoBillableMetric, 'lago_id'>) {
    const r = await this.call<{ billable_metric: LagoBillableMetric }>(
      'POST',
      '/billable_metrics',
      {
        billable_metric: m,
      },
    );
    return r.billable_metric;
  }

  async getPlan(code: string) {
    const r = await this.orNull(
      this.call<{ plan: LagoPlan }>('GET', `/plans/${encodeURIComponent(code)}`),
    );
    return r?.plan ?? null;
  }

  async createPlan(p: LagoPlan) {
    return (await this.call<{ plan: LagoPlan }>('POST', '/plans', { plan: p })).plan;
  }

  /** Lago's create is an upsert on external_id. */
  async upsertCustomer(c: LagoCustomer) {
    await this.call('POST', '/customers', { customer: c });
  }

  /** Lago returns the existing subscription when the external_id is known. */
  async createSubscription(s: Parameters<LagoApi['createSubscription']>[0]) {
    const r = await this.call<{ subscription: LagoSubscription }>('POST', '/subscriptions', {
      subscription: s,
    });
    return r.subscription;
  }

  async getSubscription(externalId: string) {
    const r = await this.orNull(
      this.call<{ subscription: LagoSubscription }>(
        'GET',
        `/subscriptions/${encodeURIComponent(externalId)}`,
      ),
    );
    return r?.subscription ?? null;
  }

  async sendEvent(e: LagoEvent) {
    await this.call('POST', '/events', { event: e });
  }

  async currentUsage(externalCustomerId: string, externalSubscriptionId: string) {
    const q = new URLSearchParams({ external_subscription_id: externalSubscriptionId });
    const r = await this.call<{ customer_usage: LagoUsage }>(
      'GET',
      `/customers/${encodeURIComponent(externalCustomerId)}/current_usage?${q}`,
    );
    return r.customer_usage;
  }
}
