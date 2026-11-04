// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger } from '@katip/shared';
import type { BridgeDeps } from './bridge.js';
import { buildCatalog, KVKK_SEATS, type Catalog } from './catalog.js';
import type { Config } from './config.js';
import { LagoClient } from './lago.js';
import { PgBillingStore } from './store.js';

/** The real store, Lago client and catalog, from the environment. */
export async function realDeps(config: Config): Promise<BridgeDeps & { catalog: Catalog }> {
  const store = new PgBillingStore(config.DATABASE_URL);
  const catalog = buildCatalog(await store.plans(), {
    overageStandardUsdMicroPerM: config.BILLING_OVERAGE_STANDARD_USD_MICRO_PER_M,
    overagePremiumUsdMicroPerM: config.BILLING_OVERAGE_PREMIUM_USD_MICRO_PER_M,
    seatsInAdvance: config.BILLING_SEATS_IN_ADVANCE,
  });
  return {
    store,
    lago: new LagoClient(config.LAGO_API_URL, config.LAGO_API_KEY),
    now: () => new Date(),
    log: createLogger('billing-bridge'),
    catalog,
    settings: {
      graceMinutes: config.BILLING_GRACE_MINUTES,
      lookbackDays: config.BILLING_LOOKBACK_DAYS,
      seatMetrics: catalog.seatMetrics,
      kvkkMetric: catalog.metrics.some((m) => m.code === KVKK_SEATS) ? KVKK_SEATS : null,
    },
  };
}
