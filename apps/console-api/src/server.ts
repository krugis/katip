// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger } from '@katip/shared';
import { Redis } from 'ioredis';
import { buildApi } from './app.js';
import { createVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { HttpIdentityClient } from './identity.js';
import { DbConsoleStore } from './stores.js';

const config = loadConfig();
const log = createLogger('console-api', { level: config.LOG_LEVEL });
const store = new DbConsoleStore(config.DATABASE_URL);
const valkey = config.VALKEY_URL
  ? new Redis(config.VALKEY_URL, { maxRetriesPerRequest: 1 })
  : undefined;
valkey?.on('error', (e: Error) => log.warn({ err: { name: e.name } }, 'valkey error'));

const app = await buildApi({
  store,
  identity: new HttpIdentityClient(config.IDENTITY_URL, config.IDENTITY_TOKEN),
  ...(valkey ? { events: valkey } : {}),
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
  valkey?.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
