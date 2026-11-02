// SPDX-License-Identifier: AGPL-3.0-only
import { Redis } from 'ioredis';
import { createLogger } from '@katip/shared';
import { PresidioClient } from '@katip/pii';
import { buildGateway } from './app.js';
import { loadConfig } from './config.js';
import {
  DbCatalogStore,
  DbPolicySource,
  DbTenantStore,
  DbUsageSink,
  ValkeyQuotaStore,
} from './db-stores.js';
import { MemoryQuotaStore, MemoryTenantStore, MemoryUsageSink, loadDevTenants } from './stores.js';

const config = loadConfig();
const log = createLogger('policy-gateway', { level: config.LOG_LEVEL });

const redis = config.VALKEY_URL
  ? new Redis(config.VALKEY_URL, { lazyConnect: false, maxRetriesPerRequest: 3 })
  : null;

let tenants;
if (config.DEV_TENANTS_FILE) {
  log.warn('DEV_TENANTS_FILE set: using the dev tenants file (dev only)');
  tenants = loadDevTenants(config.DEV_TENANTS_FILE);
} else if (config.DATABASE_URL) {
  tenants = new DbTenantStore(config.DATABASE_URL, redis);
} else {
  log.warn(
    'neither DATABASE_URL nor DEV_TENANTS_FILE set: no tenants loaded, every request will be rejected',
  );
  tenants = new MemoryTenantStore();
}

// Quota counters: Valkey Lua when available, in-memory otherwise (dev only).
// Usage: Postgres writer with a Valkey outbox when the DB URL is set.
const useDb = Boolean(config.DATABASE_URL) && !config.DEV_TENANTS_FILE;
const quota = redis && useDb ? new ValkeyQuotaStore(redis) : new MemoryQuotaStore();
const usage = useDb
  ? new DbUsageSink(config.DATABASE_URL!, { redis, logger: log })
  : new MemoryUsageSink();
// Effective policy (tenant + department override) with policy.changed invalidation.
const policySource = useDb
  ? new DbPolicySource(config.DATABASE_URL!, redis, { logger: log })
  : null;
if (policySource) await policySource.start();

// Presidio PERSON NER (P1-11): on failure, the tenant's pii.onDetectorFailure decides.
const presidio = config.PRESIDIO_URL ? new PresidioClient({ baseUrl: config.PRESIDIO_URL }) : null;

const catalogStore = useDb ? new DbCatalogStore(config.DATABASE_URL!) : null;

const app = buildGateway({
  litellmBaseUrl: config.LITELLM_BASE_URL,
  litellmApiKey: config.LITELLM_API_KEY,
  upstreamTimeoutMs: config.UPSTREAM_TIMEOUT_MS,
  tenants,
  quota,
  usage,
  ...(policySource ? { policySource } : {}),
  ...(catalogStore
    ? {
        catalogStore,
        // Throws until migrated; empty until seeded. Either way: not ready.
        ready: async () => (await catalogStore.getCatalog()).length > 0,
      }
    : {}),
  ...(presidio ? { piiDetector: (text) => presidio.detect(text) } : {}),
  logger: log,
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  await app.close();
  if (tenants instanceof DbTenantStore) await tenants.close();
  if (usage instanceof DbUsageSink) await usage.close();
  if (policySource) await policySource.close();
  redis?.quit();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
