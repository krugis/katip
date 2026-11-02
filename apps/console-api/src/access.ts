// SPDX-License-Identifier: AGPL-3.0-only
// A company's access rules (LLD-02 §6, tracker P1-28). Traefik polls the allowlists from
// here. If it can't load them when it starts, the company's route answers 404 rather than
// opening up.
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { Errors } from '@katip/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Caller } from './auth.js';
import type { IdentityClient } from './identity.js';
import type { Actor, ConsoleStore } from './stores.js';

/** Keycloak's realm limits (keycloak.mjs): a client can only shorten them. */
const MAX_IDLE_MIN = 30;
const MAX_SESSION_H = 10;

/** `203.0.113.7` or `203.0.113.0/24`, as a CIDR. Null if it's neither. */
export function normalizeCidr(text: string): string | null {
  const [address, prefix, extra] = text.trim().split('/');
  if (!address || extra !== undefined) return null;
  const family = isIPv4(address) ? 4 : isIPv6(address) ? 6 : 0;
  if (family === 0) return null;
  const max = family === 4 ? 32 : 128;
  if (prefix === undefined) return `${address}/${max}`;
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return null;
  return `${address}/${Number(prefix)}`;
}

const plainIp = (ip: string): string => ip.replace(/^::ffff:/, '');

export function ipMatches(ip: string, cidrs: string[]): boolean {
  const address = plainIp(ip);
  const family = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
  if (!family) return false;
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [network, prefix] = cidr.split('/');
    const networkFamily = isIPv4(network!) ? 'ipv4' : 'ipv6';
    list.addSubnet(network!, Number(prefix), networkFamily);
  }
  return list.check(address, family);
}

const RulesSchema = z.object({
  ipAllowlist: z.array(z.string()).max(100),
  countries: z
    .array(z.string().regex(/^[A-Za-z]{2}$/))
    .min(1)
    .max(250),
  sessionIdleMin: z.number().int().min(5).max(MAX_IDLE_MIN),
  sessionMaxH: z.number().int().min(1).max(MAX_SESSION_H),
});

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});
const errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];
const TenantParams = z.object({ tid: z.string().uuid() });

/** The caller's address, as Traefik saw it. Traefik overwrites this header on every request. */
const callerIp = (req: FastifyRequest): string => {
  const header = req.headers['x-real-ip'];
  return plainIp((typeof header === 'string' && header) || req.ip);
};

const actorOf = (caller: Caller): Actor =>
  caller.kind === 'provider'
    ? { type: 'provider', id: caller.sub }
    : { type: 'user', id: caller.user.id };

/** What Traefik's HTTP provider reads. An empty allowlist lets everyone through. */
export const traefikConfig = (rules: { slug: string; ipAllowlist: string[] }[]) => ({
  http: {
    middlewares: Object.fromEntries(
      rules.map(({ slug, ipAllowlist }) => [
        `${slug}-ipallow`,
        {
          ipAllowList: {
            sourceRange: ipAllowlist.length > 0 ? ipAllowlist : ['0.0.0.0/0', '::/0'],
          },
        },
      ]),
    ),
  },
});

export function registerAccessRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  identity: IdentityClient,
  prefix: string,
  callerOf: (req: FastifyRequest) => Caller,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const access = { roles: ['tenant_admin'], tenantParam: 'tid' } as const;
  const Response = RulesSchema.extend({ mfaRequired: z.boolean(), callerIp: z.string() });

  // Outside /api: Traefik's public route only forwards /api here, and this holds no secrets.
  app.get('/internal/traefik', { schema: { hide: true } }, async () =>
    traefikConfig(await store.allIpAllowlists()),
  );

  app.get(
    `${prefix}/tenants/:tid/access-rules`,
    {
      config: { access },
      schema: {
        summary: "The company's access rules, and the caller's address",
        security: secured,
        params: TenantParams,
        response: { 200: Response, ...errors },
      },
    },
    async (req) => {
      const rules = await store.accessRules(req.params.tid);
      if (!rules) throw Errors.notFound();
      return { ...rules, callerIp: callerIp(req) };
    },
  );

  app.put(
    `${prefix}/tenants/:tid/access-rules`,
    {
      config: { access },
      schema: {
        summary: "Change the company's access rules",
        security: secured,
        params: TenantParams,
        body: RulesSchema.extend({ force: z.boolean().optional() }).strict(),
        response: { 200: Response, ...errors },
      },
    },
    async (req) => {
      const { force, ...body } = req.body;
      const ipAllowlist: string[] = [];
      for (const entry of body.ipAllowlist) {
        const cidr = normalizeCidr(entry);
        if (!cidr) throw Errors.badRequest(`Not an address or range: ${entry}`);
        ipAllowlist.push(cidr);
      }
      const ip = callerIp(req);
      if (ipAllowlist.length > 0 && !force && !ipMatches(ip, ipAllowlist)) {
        throw Errors.conflict('would_lock_out', 'This list leaves out your own address');
      }
      const tenant = await store.tenantById(req.params.tid);
      if (!tenant) throw Errors.notFound();
      const rules = await store.saveAccessRules(
        tenant.id,
        { ...body, ipAllowlist, countries: body.countries.map((c) => c.toUpperCase()) },
        actorOf(callerOf(req)),
        // Inside the transaction: if Keycloak fails, the database doesn't change either.
        () =>
          identity.setSessionLimits(tenant.slug, body.sessionIdleMin * 60, body.sessionMaxH * 3600),
      );
      return { ...rules, callerIp: ip };
    },
  );
}
