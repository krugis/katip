// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger } from '@katip/shared';
import { buildGateway } from './app.js';
import { loadConfig } from './config.js';
import { MemoryQuotaStore, MemoryTenantStore, MemoryUsageSink, loadDevTenants } from './stores.js';

const config = loadConfig();
const log = createLogger('policy-gateway', { level: config.LOG_LEVEL });

if (!config.DEV_TENANTS_FILE) {
  log.warn(
    'DEV_TENANTS_FILE not set: no tenants loaded, every request will be rejected (Postgres store arrives with P1-17)',
  );
}

const app = buildGateway({
  litellmBaseUrl: config.LITELLM_BASE_URL,
  litellmApiKey: config.LITELLM_API_KEY,
  upstreamTimeoutMs: config.UPSTREAM_TIMEOUT_MS,
  tenants: config.DEV_TENANTS_FILE
    ? loadDevTenants(config.DEV_TENANTS_FILE)
    : new MemoryTenantStore(),
  quota: new MemoryQuotaStore(),
  usage: new MemoryUsageSink(),
  logger: log,
});

await app.listen({ host: config.HOST, port: config.PORT });
