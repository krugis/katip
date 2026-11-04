// SPDX-License-Identifier: AGPL-3.0-only
// What Lago must hold (LLD-06 §2), made from the governance `plans` table (DESIGN §5, seeded by
// packages/db) and the overage prices in katip.config.yaml. Created once and then only checked:
// a price that differs is reported, never changed here, because a price change is the owner's
// decision and would apply to every company on the plan.
import type { LagoApi, LagoBillableMetric, LagoCharge, LagoPlan } from './lago.js';

export const MONTHLY_PLAN = 'katip_monthly';
export const STANDARD_TOKENS = 'standard_tokens';
export const PREMIUM_TOKENS = 'premium_tokens';
export const KVKK_SEATS = 'kvkk_seats';
export const seatMetric = (planCode: string) => `seats_${planCode}`;

/** The gateway's quota classes (policy-gateway quotaClassOf): tr and embedding count as standard. */
export const TOKEN_METRIC = { standard: STANDARD_TOKENS, premium: PREMIUM_TOKENS } as const;
export type TokenClass = keyof typeof TOKEN_METRIC;

export interface PlanRow {
  code: string;
  version: number;
  monthlyPriceUsdMicro: number;
}

export interface BillingPrices {
  /** micro-USD per 1M overage tokens (LLD-06 §2). */
  overageStandardUsdMicroPerM: number;
  overagePremiumUsdMicroPerM: number;
  /** Seats are invoiced at the start of the month, or at its end. */
  seatsInAdvance: boolean;
}

export interface Catalog {
  metrics: Omit<LagoBillableMetric, 'lago_id'>[];
  plan: LagoPlan;
  /** Seat metric by the plan code in `seats`. */
  seatMetrics: Record<string, string>;
}

/** Exact decimal string of `micro / 10^shift` USD, with no float in between. */
export function microToUsd(micro: number, shift = 6): string {
  if (!Number.isSafeInteger(micro) || micro < 0) throw new Error(`not a price: ${micro}`);
  const s = String(micro).padStart(shift + 1, '0');
  const whole = s.slice(0, s.length - shift);
  const frac = s.slice(s.length - shift).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** micro-USD per 1M tokens as Lago's per-token amount: 1_000_000 → "0.000001". */
export const perTokenUsd = (microPerM: number) => microToUsd(microPerM, 12);

/** "9.60" and "9.6" are the same price. */
export const sameAmount = (a: string, b: string) => {
  const norm = (x: string) => {
    const [w = '0', f = ''] = x.trim().split('.');
    return `${w.replace(/^0+(?=\d)/, '')}.${f.replace(/0+$/, '')}`;
  };
  return norm(a) === norm(b);
};

/** The latest version of each plan, as the seed never updates one in place. */
export function latestPlans(rows: PlanRow[]): PlanRow[] {
  const byCode = new Map<string, PlanRow>();
  for (const r of rows) {
    const seen = byCode.get(r.code);
    if (!seen || r.version > seen.version) byCode.set(r.code, r);
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function buildCatalog(planRows: PlanRow[], prices: BillingPrices): Catalog {
  const plans = latestPlans(planRows);
  const kvkk = plans.find((p) => p.code === 'kvkk_addon');
  // A plan with a price is sold by the seat. community is free and self-hosted.
  const seatPlans = plans.filter((p) => p.code !== 'kvkk_addon' && p.monthlyPriceUsdMicro > 0);
  if (seatPlans.length === 0) throw new Error('no priced plan in the plans table: seed it first');

  const recurring = (code: string, name: string) => ({
    code,
    name,
    aggregation_type: 'sum_agg',
    field_name: 'seats',
    recurring: true,
  });
  const seatCharge = (code: string, monthlyMicro: number): LagoCharge => ({
    code,
    billable_metric_code: code,
    charge_model: 'standard',
    pay_in_advance: prices.seatsInAdvance,
    prorated: true,
    properties: { amount: microToUsd(monthlyMicro) },
  });
  const tokenCharge = (code: string, microPerM: number): LagoCharge => ({
    code,
    billable_metric_code: code,
    charge_model: 'standard',
    pay_in_advance: false,
    prorated: false,
    properties: { amount: perTokenUsd(microPerM) },
  });

  const metrics = [
    ...seatPlans.map((p) => recurring(seatMetric(p.code), `Seats: ${p.code}`)),
    ...(kvkk ? [recurring(KVKK_SEATS, 'KVKK add-on seats')] : []),
    {
      code: STANDARD_TOKENS,
      name: 'Overage standard tokens',
      aggregation_type: 'sum_agg',
      field_name: 'tokens',
      recurring: false,
    },
    {
      code: PREMIUM_TOKENS,
      name: 'Overage premium tokens',
      aggregation_type: 'sum_agg',
      field_name: 'tokens',
      recurring: false,
    },
  ];
  const charges = [
    ...seatPlans.map((p) => seatCharge(seatMetric(p.code), p.monthlyPriceUsdMicro)),
    ...(kvkk ? [seatCharge(KVKK_SEATS, kvkk.monthlyPriceUsdMicro)] : []),
    tokenCharge(STANDARD_TOKENS, prices.overageStandardUsdMicroPerM),
    tokenCharge(PREMIUM_TOKENS, prices.overagePremiumUsdMicroPerM),
  ];
  return {
    metrics,
    plan: {
      code: MONTHLY_PLAN,
      name: 'Kâtip monthly',
      interval: 'monthly',
      amount_cents: 0,
      amount_currency: 'USD',
      pay_in_advance: false,
      charges,
    },
    seatMetrics: Object.fromEntries(seatPlans.map((p) => [p.code, seatMetric(p.code)])),
  };
}

/** Differences between what Lago has and what it should have. Empty means it matches. */
export function planDifferences(want: LagoPlan, have: LagoPlan): string[] {
  const out: string[] = [];
  for (const k of ['interval', 'amount_cents', 'amount_currency'] as const) {
    if (want[k] !== have[k]) out.push(`${want.code}.${k}: Lago has ${have[k]}, wanted ${want[k]}`);
  }
  for (const c of want.charges) {
    const h = have.charges.find((x) => x.code === c.code);
    const where = `${want.code}.${c.code}`;
    if (!h) {
      out.push(`${where}: missing in Lago`);
      continue;
    }
    if (h.billable_metric_code !== c.billable_metric_code) out.push(`${where}: another metric`);
    if (h.charge_model !== c.charge_model) out.push(`${where}.charge_model: ${h.charge_model}`);
    if (h.pay_in_advance !== c.pay_in_advance) {
      out.push(`${where}.pay_in_advance: Lago has ${h.pay_in_advance}`);
    }
    if (h.prorated !== c.prorated) out.push(`${where}.prorated: Lago has ${h.prorated}`);
    if (!sameAmount(h.properties.amount, c.properties.amount)) {
      out.push(`${where}: Lago charges ${h.properties.amount}, wanted ${c.properties.amount}`);
    }
  }
  for (const h of have.charges) {
    if (!want.charges.some((c) => c.code === h.code)) out.push(`${want.code}.${h.code}: extra`);
  }
  return out;
}

export interface CatalogResult {
  created: string[];
  unchanged: string[];
}

/** Creates what's missing. Throws, listing every difference, when something is set otherwise. */
export async function ensureCatalog(lago: LagoApi, catalog: Catalog): Promise<CatalogResult> {
  const created: string[] = [];
  const unchanged: string[] = [];
  const problems: string[] = [];
  const ids = new Map<string, string>();
  for (const m of catalog.metrics) {
    let have = await lago.getBillableMetric(m.code);
    if (!have) {
      have = await lago.createBillableMetric(m);
      created.push(`metric ${m.code}`);
    } else {
      for (const k of ['aggregation_type', 'field_name', 'recurring'] as const) {
        if (have[k] !== m[k]) problems.push(`metric ${m.code}.${k}: Lago has ${String(have[k])}`);
      }
      unchanged.push(`metric ${m.code}`);
    }
    if (have.lago_id) ids.set(m.code, have.lago_id);
  }
  const have = await lago.getPlan(catalog.plan.code);
  if (!have) {
    await lago.createPlan({
      ...catalog.plan,
      charges: catalog.plan.charges.map(({ billable_metric_code, ...c }) => ({
        ...c,
        billable_metric_id: ids.get(billable_metric_code ?? '') ?? '',
      })),
    });
    created.push(`plan ${catalog.plan.code}`);
  } else {
    problems.push(...planDifferences(catalog.plan, have));
    unchanged.push(`plan ${catalog.plan.code}`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Lago's catalog differs from the plans and katip.config.yaml. Prices are changed on purpose, ` +
        `not by setup (docs/runbooks/billing.md):\n  ${problems.join('\n  ')}`,
    );
  }
  return { created, unchanged };
}
