// SPDX-License-Identifier: AGPL-3.0-only
// The internal identity service: on the backend network only, never behind Traefik, and
// the one long-running holder of the provisioner's Keycloak rights (see identity.ts).
import { createLogger, loadEnv, safeEqual, type Logger } from '@katip/shared';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdentityRefused, TENANT_ROLES, TenantUsers } from './identity.js';
import { KeycloakAdmin } from './keycloak.js';

const Slug = z.string().regex(/^[a-z0-9-]{3,32}$/);
const Email = z.string().email();
const Role = z.enum(TENANT_ROLES);

export function buildIdentityServer(
  users: TenantUsers,
  token: string,
  logger: Logger,
): FastifyInstance {
  // No request logging: these bodies hold email addresses.
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    disableRequestLogging: true,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof IdentityRefused) {
      return reply.code(err.status).send({ code: err.code });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ code: 'bad_request' });
    req.log.error({ err: { name: (err as Error).name } }, 'identity request failed');
    return reply.code(502).send({ code: 'keycloak_failed' });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const sent = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
    if (!safeEqual(sent, token)) await reply.code(401).send({ code: 'unauthorized' });
  });

  const slugOf = (params: unknown) => z.object({ slug: Slug }).parse(params).slug;

  app.post('/v1/tenants/:slug/users', async (req) => {
    const body = z.object({ email: Email, name: z.string().min(1), role: Role }).parse(req.body);
    return users.invite(slugOf(req.params), body);
  });

  app.post('/v1/tenants/:slug/users/send-invite', async (req) => {
    const { email } = z.object({ email: Email }).parse(req.body);
    await users.sendInvite(slugOf(req.params), email);
    return {};
  });

  app.put('/v1/tenants/:slug/users/role', async (req) => {
    const { email, role } = z.object({ email: Email, role: Role }).parse(req.body);
    await users.setRole(slugOf(req.params), email, role);
    return {};
  });

  app.put('/v1/tenants/:slug/session-limits', async (req) => {
    const { idleSeconds, maxSeconds } = z
      .object({
        idleSeconds: z.number().int().min(60).max(1800),
        maxSeconds: z.number().int().min(3600).max(36_000),
      })
      .parse(req.body);
    await users.setSessionLimits(slugOf(req.params), idleSeconds, maxSeconds);
    return {};
  });

  app.put('/v1/tenants/:slug/users/enabled', async (req) => {
    const { email, enabled } = z.object({ email: Email, enabled: z.boolean() }).parse(req.body);
    await users.setEnabled(slugOf(req.params), email, enabled);
    return {};
  });

  return app;
}

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(8090),
  HOST: z.string().default('0.0.0.0'),
  KEYCLOAK_URL: z.string().url(),
  KEYCLOAK_REALM: z.string().min(1),
  KEYCLOAK_CLIENT_ID: z.string().min(1),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1),
  BASE_DOMAIN: z.string().min(1),
  IDENTITY_TOKEN: z.string().min(32),
});

if (process.argv[1]?.endsWith('identity-server.js')) {
  const config = loadEnv(ConfigSchema);
  const log = createLogger('identity');
  const directory = new KeycloakAdmin({
    url: config.KEYCLOAK_URL,
    realm: config.KEYCLOAK_REALM,
    clientId: config.KEYCLOAK_CLIENT_ID,
    clientSecret: config.KEYCLOAK_CLIENT_SECRET,
    baseDomain: config.BASE_DOMAIN,
  });
  const app = buildIdentityServer(new TenantUsers(directory), config.IDENTITY_TOKEN, log);
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
  await app.listen({ host: config.HOST, port: config.PORT });
}
