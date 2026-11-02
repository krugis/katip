// SPDX-License-Identifier: AGPL-3.0-only
// Console API skeleton (LLD-04 §2, tracker P1-20): token check, role and tenant checks,
// problem+json errors and OpenAPI generated from Zod. Screens' endpoints arrive with
// their own tasks; each one must declare who may use it, or the server won't start.
import swagger from '@fastify/swagger';
import { AppError, createLogger, Errors, type Logger, type PolicyPublisher } from '@katip/shared';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import { authorize, resolveCaller, type Access, type Caller, type TokenVerifier } from './auth.js';
import type { IdentityClient } from './identity.js';
import type { ConsoleStore } from './stores.js';
import { registerUserRoutes } from './users.js';
import { registerCompanyRoutes } from './company.js';
import { registerPolicyRoutes } from './policy.js';
import { registerAccessRoutes } from './access.js';
import { registerUsageRoutes } from './usage.js';
import { registerDepartmentRoutes } from './department.js';
import { registerPortalRoutes } from './portal.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Required on every /api/v1 route, unless it's marked public. */
    access?: Access;
    public?: boolean;
  }
  interface FastifyRequest {
    caller: Caller | null;
  }
}

export interface ConsoleDeps {
  store: ConsoleStore;
  identity: IdentityClient;
  /** Tells the gateways a policy changed. Without it, they notice within 30 s anyway. */
  events?: PolicyPublisher;
  verifyToken: TokenVerifier;
  logger?: Logger;
  /** Routes added after the access check is in place; for testing that check. */
  extraRoutes?: (app: FastifyInstance) => void;
}

const TenantSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  status: z.string(),
});

const MeSchema = z.object({
  roles: z.array(z.string()),
  tenant: TenantSchema.nullable(),
  user: z
    .object({ id: z.string().uuid(), email: z.string(), name: z.string(), role: z.string() })
    .nullable(),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});

const errorResponses = { 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];
const API_PREFIX = '/api/v1';

const callerOf = (req: FastifyRequest): Caller => {
  if (!req.caller) throw Errors.unauthorized();
  return req.caller;
};

export async function buildApi(deps: ConsoleDeps): Promise<FastifyInstance> {
  const log = deps.logger ?? createLogger('console-api');
  const app = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    disableRequestLogging: false,
  }).withTypeProvider<ZodTypeProvider>();
  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (_req, body, done) =>
    done(null, body),
  );
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('caller', null);

  app.setErrorHandler((err, req, reply) => {
    let problem: AppError;
    if (err instanceof AppError) {
      problem = err;
      req.log.info({ code: err.code, status: err.status }, 'request rejected');
    } else if (hasZodFastifySchemaValidationErrors(err)) {
      problem = Errors.badRequest('Invalid request');
    } else {
      const e = err as Error;
      req.log.error({ err: { message: e.message, name: e.name } }, 'unhandled error');
      problem = new AppError(500, 'internal_error', 'Something went wrong');
    }
    return reply.code(problem.status).type('application/problem+json').send(problem.toProblem());
  });
  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).type('application/problem+json').send(Errors.notFound().toProblem()),
  );

  await app.register(swagger, {
    openapi: {
      info: { title: 'Kâtip console API', version: '0.0.0' },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: jsonSchemaTransform,
  });

  // Deny by default: an API route that doesn't say who may use it stops the server starting.
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith(API_PREFIX)) return;
    const config = route.config as { access?: Access; public?: boolean } | undefined;
    if (!config?.public && !config?.access) {
      throw new Error(`${route.method} ${route.url} does not declare its access`);
    }
  });

  app.addHook('preHandler', async (req) => {
    const access = req.routeOptions.config.access;
    if (!access) return;
    req.caller = await resolveCaller(req.headers.authorization, deps.verifyToken, deps.store);
    authorize(req.caller, access, req.params as Record<string, unknown>);
  });

  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    const ready = await deps.store.ready().catch(() => false);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'not_ready' });
  });

  app.get(
    `${API_PREFIX}/openapi.json`,
    { config: { public: true }, schema: { hide: true } },
    async () => app.swagger(),
  );

  app.get(
    `${API_PREFIX}/me`,
    {
      config: { access: { roles: 'any' } },
      schema: {
        summary: 'The caller: roles, company and user',
        security: secured,
        response: { 200: MeSchema, 401: ProblemSchema, 403: ProblemSchema },
      },
    },
    async (req) => {
      const caller = callerOf(req);
      if (caller.kind === 'provider') return { roles: caller.roles, tenant: null, user: null };
      const { id, email, name, role } = caller.user;
      return { roles: caller.roles, tenant: caller.tenant, user: { id, email, name, role } };
    },
  );

  app.get(
    `${API_PREFIX}/tenants/:tid`,
    {
      config: { access: { roles: ['tenant_admin'], tenantParam: 'tid' } },
      schema: {
        summary: 'One company',
        security: secured,
        params: z.object({ tid: z.string().uuid() }),
        response: { 200: TenantSchema, ...errorResponses },
      },
    },
    async (req) => {
      const tenant = await deps.store.tenantById(req.params.tid);
      if (!tenant) throw Errors.notFound();
      return tenant;
    },
  );

  app.get(
    `${API_PREFIX}/admin/tenants`,
    {
      config: { access: { roles: [] } },
      schema: {
        summary: 'All companies (provider admins)',
        security: secured,
        response: { 200: z.object({ tenants: z.array(TenantSchema) }), ...errorResponses },
      },
    },
    async () => ({ tenants: await deps.store.listTenants() }),
  );

  registerUserRoutes(app as unknown as FastifyInstance, deps, API_PREFIX, callerOf);
  registerCompanyRoutes(app as unknown as FastifyInstance, deps.store, API_PREFIX, callerOf);
  registerUsageRoutes(app as unknown as FastifyInstance, deps.store, API_PREFIX);
  registerDepartmentRoutes(app as unknown as FastifyInstance, deps.store, API_PREFIX, callerOf);
  registerPortalRoutes(app as unknown as FastifyInstance, deps.store, API_PREFIX, callerOf);
  registerAccessRoutes(
    app as unknown as FastifyInstance,
    deps.store,
    deps.identity,
    API_PREFIX,
    callerOf,
  );
  registerPolicyRoutes(
    app as unknown as FastifyInstance,
    deps.store,
    deps.events,
    API_PREFIX,
    callerOf,
    log,
  );

  deps.extraRoutes?.(app as unknown as FastifyInstance);
  await app.ready();
  return app as unknown as FastifyInstance;
}
