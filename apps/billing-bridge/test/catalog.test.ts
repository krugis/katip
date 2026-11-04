// SPDX-License-Identifier: AGPL-3.0-only
// P1-36: Lago's metrics and plan come from the plans table and katip.config.yaml, are created
// once, and a price that differs is reported, not changed.
import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  ensureCatalog,
  latestPlans,
  microToUsd,
  perTokenUsd,
  planDifferences,
  sameAmount,
  type PlanRow,
} from '../src/catalog.js';
import { FakeLago } from './fakes.js';

/** The seed's plans v1 (DESIGN §5): monthly is the annual price + 20%. */
const PLANS: PlanRow[] = [
  { code: 'community', version: 1, monthlyPriceUsdMicro: 0 },
  { code: 'starter', version: 1, monthlyPriceUsdMicro: 7_200_000 },
  { code: 'business', version: 1, monthlyPriceUsdMicro: 9_600_000 },
  { code: 'studio', version: 1, monthlyPriceUsdMicro: 16_800_000 },
  { code: 'kvkk_addon', version: 1, monthlyPriceUsdMicro: 8_400_000 },
];
const PRICES = {
  overageStandardUsdMicroPerM: 1_000_000,
  overagePremiumUsdMicroPerM: 6_000_000,
  seatsInAdvance: true,
};

describe('amounts', () => {
  it('turns micro-USD into exact decimal strings', () => {
    expect(microToUsd(9_600_000)).toBe('9.6');
    expect(microToUsd(16_800_000)).toBe('16.8');
    expect(microToUsd(149_000_000)).toBe('149');
    expect(microToUsd(1)).toBe('0.000001');
    expect(perTokenUsd(1_000_000)).toBe('0.000001');
    expect(perTokenUsd(6_000_000)).toBe('0.000006');
    expect(perTokenUsd(1_500_000)).toBe('0.0000015');
    expect(() => microToUsd(-1)).toThrow();
    expect(() => microToUsd(1.5)).toThrow();
  });

  it('compares amounts as numbers written differently', () => {
    expect(sameAmount('9.6', '9.60')).toBe(true);
    expect(sameAmount('0.000001', '0.0000010')).toBe(true);
    expect(sameAmount('9.6', '9.7')).toBe(false);
  });
});

describe('the catalog', () => {
  it('has a seat charge per priced plan, the KVKK seats, and the overage tokens', () => {
    const c = buildCatalog(PLANS, PRICES);
    expect(c.metrics.map((m) => [m.code, m.recurring])).toEqual([
      ['seats_business', true],
      ['seats_starter', true],
      ['seats_studio', true],
      ['kvkk_seats', true],
      ['standard_tokens', false],
      ['premium_tokens', false],
    ]);
    expect(
      c.plan.charges.map((x) => [x.code, x.properties.amount, x.pay_in_advance, x.prorated]),
    ).toEqual([
      ['seats_business', '9.6', true, true],
      ['seats_starter', '7.2', true, true],
      ['seats_studio', '16.8', true, true],
      ['kvkk_seats', '8.4', true, true],
      ['standard_tokens', '0.000001', false, false],
      ['premium_tokens', '0.000006', false, false],
    ]);
    expect(c.plan).toMatchObject({ code: 'katip_monthly', interval: 'monthly', amount_cents: 0 });
    expect(c.seatMetrics).toEqual({
      business: 'seats_business',
      starter: 'seats_starter',
      studio: 'seats_studio',
    });
  });

  it('uses the latest version of a plan', () => {
    const rows = [...PLANS, { code: 'business', version: 2, monthlyPriceUsdMicro: 10_800_000 }];
    expect(latestPlans(rows).find((p) => p.code === 'business')?.version).toBe(2);
    const c = buildCatalog(rows, PRICES);
    expect(c.plan.charges.find((x) => x.code === 'seats_business')?.properties.amount).toBe('10.8');
  });

  it('refuses to make a catalog with no priced plan', () => {
    expect(() => buildCatalog([PLANS[0]!], PRICES)).toThrow(/no priced plan/);
  });
});

describe('ensureCatalog', () => {
  it('creates everything once, then finds it as it is', async () => {
    const lago = new FakeLago();
    const c = buildCatalog(PLANS, PRICES);
    const first = await ensureCatalog(lago, c);
    expect(first.created).toContain('plan katip_monthly');
    expect(first.created).toHaveLength(7);
    const again = await ensureCatalog(lago, c);
    expect(again.created).toEqual([]);
    expect(planDifferences(c.plan, lago.plans.get('katip_monthly')!)).toEqual([]);
  });

  it('reports a price that differs, and changes nothing', async () => {
    const lago = new FakeLago();
    await ensureCatalog(lago, buildCatalog(PLANS, PRICES));
    const dearer = buildCatalog(PLANS, { ...PRICES, overagePremiumUsdMicroPerM: 7_000_000 });
    await expect(ensureCatalog(lago, dearer)).rejects.toThrow(
      /premium_tokens: Lago charges 0.000006, wanted 0.000007/,
    );
    const premium = lago.plans
      .get('katip_monthly')!
      .charges.find((x) => x.code === 'premium_tokens');
    expect(premium?.properties.amount).toBe('0.000006');
    const arrears = buildCatalog(PLANS, { ...PRICES, seatsInAdvance: false });
    await expect(ensureCatalog(lago, arrears)).rejects.toThrow(/pay_in_advance/);
  });
});
