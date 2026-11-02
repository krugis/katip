// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger } from '@katip/shared';
import { buildApi } from './app.js';
import { createVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { DbConsoleStore } from './stores.js';

const config = loadConfig();
const log = createLogger('console-api', { level: config.LOG_LEVEL });
const store = new DbConsoleStore(config.DATABASE_URL);

const app = await buildApi({
  store,
  verifyToken: createVerifier({
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    keys: remoteKeys(config.OIDC_JWKS_URL),
  }),
  logger: log,
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  await app.close();
  await store.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
