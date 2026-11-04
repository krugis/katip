// SPDX-License-Identifier: AGPL-3.0-only
import { createLogger } from '@katip/shared';
import { Redis } from 'ioredis';
import { checkAlerts, smtpMailer } from './alerts.js';
import { buildApi } from './app.js';
import { sendChatNotices } from './chat-notice.js';
import { createVerifier, remoteKeys } from './auth.js';
import { loadConfig } from './config.js';
import { HttpIdentityClient } from './identity.js';
import { buildMetricsServer } from './metrics.js';
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
  baseDomain: config.BASE_DOMAIN,
});

const metricsServer = config.METRICS_TOKEN
  ? buildMetricsServer(store, config.METRICS_TOKEN)
  : undefined;

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  await app.close();
  await metricsServer?.close();
  await store.close();
  valkey?.disconnect();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.HOST, port: config.PORT });
await metricsServer?.listen({ host: config.HOST, port: config.METRICS_PORT });

if (config.SMTP_HOST) {
  const mailer = smtpMailer(config.SMTP_HOST, config.SMTP_PORT, config.MAIL_FROM);
  // One at a time, and several replicas are safe: each alert's or person's row is unique.
  const tick = async () => {
    await checkAlerts(store, mailer, log).catch((e: Error) =>
      log.warn({ err: { name: e.name } }, 'usage alert check failed'),
    );
    await sendChatNotices(store, mailer, log).catch((e: Error) =>
      log.warn({ err: { name: e.name } }, 'chat retention notice check failed'),
    );
    setTimeout(() => void tick(), config.ALERT_CHECK_SECONDS * 1000).unref();
  };
  void tick();
}
