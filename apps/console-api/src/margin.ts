// SPDX-License-Identifier: AGPL-3.0-only
// The provider's margin per company and month (LLD-06 §6, tracker P1-47). Provider admins only:
// a company must never see what its usage costs us. The database gives this role sums from two
// functions, and still no cost column of its own (packages/db rls.ts).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ConsoleStore } from './stores.js';
import { csvCell } from './usage.js';

/** LLD-06 §6: a company under this margin is flagged. */
export const MARGIN_TARGET_PCT = 30;

/**
 * Where revenue comes from. List price (seats × plan price, the KVKK add-on, and the overage
 * price recorded on each event) until the billing bridge (P1-37) records what Lago invoiced.
 * Then the invoiced amounts replace it in the store, and this says `invoiced`.
 */
export type RevenueBasis = 'list_price' | 'invoiced';

/** One company's month, as the database adds it up. Money in micro-USD. */
export interface MarginSource {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  billingCycle: string | null;
  seats: number;
  seatRevenue: number;
  addonRevenue: number;
  overageRevenue: number;
  cost: number;
  requests: number;
}

export interface ModelCost {
  modelId: string;
  label: string;
  class: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface MarginData {
  basis: RevenueBasis;
  tenants: MarginSource[];
  models: ModelCost[];
}

interface Money {
  seats: number;
  addons: number;
  overage: number;
  total: number;
}

export interface MarginRow {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  billingCycle: string | null;
  seats: number;
  requests: number;
  revenue: Money;
  cost: number;
  margin: number;
  marginPct: number | null;
  belowTarget: boolean;
}

/** Margin as a share of revenue, to one decimal. None when there was no revenue. */
export function marginPct(revenue: number, margin: number): number | null {
  if (revenue === 0) return null;
  return Math.round((margin * 1000) / revenue) / 10;
}

const rowOf = (s: MarginSource): MarginRow => {
  const total = s.seatRevenue + s.addonRevenue + s.overageRevenue;
  const margin = total - s.cost;
  const pct = marginPct(total, margin);
  return {
    tenantId: s.tenantId,
    slug: s.slug,
    name: s.name,
    status: s.status,
    billingCycle: s.billingCycle,
    seats: s.seats,
    requests: s.requests,
    revenue: { seats: s.seatRevenue, addons: s.addonRevenue, overage: s.overageRevenue, total },
    cost: s.cost,
    margin,
    marginPct: pct,
    // Cost with no revenue at all is below any target.
    belowTarget: pct === null ? s.cost > 0 : pct < MARGIN_TARGET_PCT,
  };
};

export function marginReport(month: string, data: MarginData) {
  const tenants = data.tenants.map(rowOf);
  const add = (pick: (r: MarginRow) => number) => tenants.reduce((n, r) => n + pick(r), 0);
  const revenue = {
    seats: add((r) => r.revenue.seats),
    addons: add((r) => r.revenue.addons),
    overage: add((r) => r.revenue.overage),
    total: add((r) => r.revenue.total),
  };
  const cost = add((r) => r.cost);
  const modelCost = data.models.reduce((n, m) => n + m.cost, 0);
  return {
    month,
    basis: data.basis,
    targetPct: MARGIN_TARGET_PCT,
    tenants,
    total: {
      seats: add((r) => r.seats),
      requests: add((r) => r.requests),
      revenue,
      cost,
      margin: revenue.total - cost,
      marginPct: marginPct(revenue.total, revenue.total - cost),
    },
    models: data.models.map((m) => ({
      ...m,
      sharePct: modelCost === 0 ? 0 : Math.round((m.cost * 1000) / modelCost) / 10,
    })),
  };
}

/** The month asked for, by default this UTC month. */
export function marginMonth(month: string | undefined, now: Date): string {
  return month ?? now.toISOString().slice(0, 7);
}

const TOTAL_LABEL = { en: 'Total', tr: 'Toplam' } as const;

/** Micro-USD as whole numbers, exact in any locale; with a byte order mark and semicolons. */
export function marginCsv(
  report: ReturnType<typeof marginReport>,
  lang: keyof typeof TOTAL_LABEL = 'en',
): string {
  const pct = (p: number | null) =>
    p === null ? '' : lang === 'tr' ? String(p).replace('.', ',') : String(p);
  const header = [
    'month',
    'slug',
    'name',
    'status',
    'seats',
    'seat_revenue_usd_micro',
    'addon_revenue_usd_micro',
    'overage_revenue_usd_micro',
    'revenue_usd_micro',
    'provider_cost_usd_micro',
    'margin_usd_micro',
    'margin_pct',
    'revenue_basis',
  ];
  const line = (
    slug: string,
    name: string,
    status: string,
    r: { seats: number; revenue: Money; cost: number; margin: number; marginPct: number | null },
  ) => [
    report.month,
    slug,
    name,
    status,
    r.seats,
    r.revenue.seats,
    r.revenue.addons,
    r.revenue.overage,
    r.revenue.total,
    r.cost,
    r.margin,
    pct(r.marginPct),
    report.basis,
  ];
  const lines = [
    header,
    ...report.tenants.map((r) => line(r.slug, r.name, r.status, r)),
    line(TOTAL_LABEL[lang], '', '', report.total),
  ];
  return `\uFEFF${lines.map((l) => l.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});
const errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];
const Query = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
const MoneySchema = z.object({
  seats: z.number(),
  addons: z.number(),
  overage: z.number(),
  total: z.number(),
});
const Report = z.object({
  month: z.string(),
  basis: z.enum(['list_price', 'invoiced']),
  targetPct: z.number(),
  tenants: z.array(
    z.object({
      tenantId: z.string(),
      slug: z.string(),
      name: z.string(),
      status: z.string(),
      billingCycle: z.string().nullable(),
      seats: z.number(),
      requests: z.number(),
      revenue: MoneySchema,
      cost: z.number(),
      margin: z.number(),
      marginPct: z.number().nullable(),
      belowTarget: z.boolean(),
    }),
  ),
  total: z.object({
    seats: z.number(),
    requests: z.number(),
    revenue: MoneySchema,
    cost: z.number(),
    margin: z.number(),
    marginPct: z.number().nullable(),
  }),
  models: z.array(
    z.object({
      modelId: z.string(),
      label: z.string(),
      class: z.string(),
      requests: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cost: z.number(),
      sharePct: z.number(),
    }),
  ),
});

export function registerMarginRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  prefix: string,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  // No roles listed: only a provider admin gets through (auth.ts). Never add a company role.
  const access = { roles: [] } as const;

  const report = async (month: string | undefined) => {
    const chosen = marginMonth(month, new Date());
    return marginReport(chosen, await store.providerMargin(chosen));
  };

  app.get(
    `${prefix}/admin/margin`,
    {
      config: { access },
      schema: {
        summary:
          'Revenue, provider cost and margin per company for one UTC month (provider admins)',
        security: secured,
        querystring: Query,
        response: { 200: Report, ...errors },
      },
    },
    async (req) => report(req.query.month),
  );

  app.get(
    `${prefix}/admin/margin/export`,
    {
      config: { access },
      schema: {
        summary: 'The same, as a CSV file (provider admins)',
        security: secured,
        querystring: Query.extend({ lang: z.enum(['tr', 'en']).default('en') }),
      },
    },
    async (req, reply) => {
      const r = await report(req.query.month);
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="margin-${r.month}.csv"`)
        .send(marginCsv(r, req.query.lang));
    },
  );
}
