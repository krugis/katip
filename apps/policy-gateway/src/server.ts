// SPDX-License-Identifier: AGPL-3.0-only
import { Redis } from 'ioredis';
import { createLogger } from '@katip/shared';
import { buildGateway } from './app.js';
import { loadConfig } from './config.js';
import { DbTenantStore } from './db-stores.js';
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

const app = buildGateway({
  litellmBaseUrl: config.LITELLM_BASE_URL,
  litellmApiKey: config.LITELLM_API_KEY,
  upstreamTimeoutMs: config.UPSTREAM_TIMEOUT_MS,
  tenants,
  quota: new MemoryQuotaStore(),
  usage: new MemoryUsageSink(),
  logger: log,
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  await app.close();
  if (tenants instanceof DbTenantStore) await tenants.close();
  redis?.quit();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
