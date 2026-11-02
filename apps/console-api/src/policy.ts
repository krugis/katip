// SPDX-License-Identifier: AGPL-3.0-only
// A company's policy (LLD-04 §1.2, §3, tracker P1-27). The gateway's cache drops it on
// policy.changed, and within 30 s even if that message is lost.
import { Errors, publishPolicyChanged, type Logger, type PolicyPublisher } from '@katip/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Caller } from './auth.js';
import type { Actor, ConsoleStore } from './stores.js';

const PiiMode = z.enum(['off', 'mask', 'block']);

export const PolicySchema = z
  .object({
    aliases: z
      .object({ auto: z.boolean(), fast: z.boolean(), best: z.boolean(), 'tr-local': z.boolean() })
      .strict(),
    allowUserModelChoice: z.boolean(),
    /** Empty means every enabled model. */
    allowedModels: z.array(z.string().min(1)).max(200),
    atQuotaLimit: z.enum(['block', 'downgrade', 'overage']),
    residency: z.enum(['ANY_APPROVED', 'EU_ONLY', 'TR_ONLY']),
    pii: z
      .object({
        mode: PiiMode,
        entities: z.record(z.string(), PiiMode).optional(),
        onDetectorFailure: z.enum(['allow', 'block']).optional(),
      })
      .strict(),
  })
  .strict();
export type PolicyDocument = z.infer<typeof PolicySchema>;

const ResponseSchema = z.object({
  policy: PolicySchema,
  version: z.number(),
  kvkkAddon: z.boolean(),
  catalog: z.array(
    z.object({
      id: z.string(),
      displayName: z.string(),
      class: z.string(),
      region: z.string(),
      dataPolicy: z.string(),
    }),
  ),
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

const actorOf = (caller: Caller): Actor =>
  caller.kind === 'provider'
    ? { type: 'provider', id: caller.sub }
    : { type: 'user', id: caller.user.id };

/** What a department can set, which is only ever stricter than its company. */
export const OverrideSchema = z
  .object({
    aliases: PolicySchema.shape.aliases.partial().optional(),
    allowedModels: z.array(z.string().min(1)).max(200).optional(),
    atQuotaLimit: z.enum(['block', 'downgrade', 'overage']).optional(),
    pii: z.object({ mode: PiiMode }).strict().optional(),
  })
  .strict();
export type OverrideDocument = z.infer<typeof OverrideSchema>;

const PII_STRICTNESS = { off: 0, mask: 1, block: 2 };
const LIMIT_STRICTNESS = { overage: 0, downgrade: 1, block: 2 };

/** Why this override would loosen the company's policy, if it would. */
export function looserThan(company: PolicyDocument, override: OverrideDocument): string | null {
  for (const [alias, on] of Object.entries(override.aliases ?? {})) {
    if (on && !company.aliases[alias as keyof PolicyDocument['aliases']]) {
      return 'A department cannot turn on an option the company has off';
    }
  }
  const models = override.allowedModels ?? [];
  if (company.allowedModels.length > 0 && models.some((m) => !company.allowedModels.includes(m))) {
    return 'A department cannot allow a model the company does not';
  }
  if (
    override.atQuotaLimit &&
    LIMIT_STRICTNESS[override.atQuotaLimit] < LIMIT_STRICTNESS[company.atQuotaLimit]
  ) {
    return 'A department cannot be less strict at the quota limit';
  }
  if (override.pii && PII_STRICTNESS[override.pii.mode] < PII_STRICTNESS[company.pii.mode]) {
    return 'A department cannot protect personal data less than the company does';
  }
  return null;
}

export function registerPolicyRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  events: PolicyPublisher | undefined,
  prefix: string,
  callerOf: (req: FastifyRequest) => Caller,
  log: Logger,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const access = { roles: ['tenant_admin'], tenantParam: 'tid' } as const;

  app.get(
    `${prefix}/tenants/:tid/policy`,
    {
      config: { access },
      schema: {
        summary: "The company's policy, and the models it can choose from",
        security: secured,
        params: TenantParams,
        response: { 200: ResponseSchema, ...errors },
      },
    },
    async (req) => {
      const policy = await store.policy(req.params.tid);
      if (!policy) throw Errors.notFound();
      return policy;
    },
  );

  app.get(
    `${prefix}/tenants/:tid/departments/:did/policy`,
    {
      config: { access },
      schema: {
        summary: "A department's stricter rules, and the company's",
        security: secured,
        params: TenantParams.extend({ did: z.string().uuid() }),
        response: {
          200: z.object({ override: OverrideSchema, company: PolicySchema }),
          ...errors,
        },
      },
    },
    async (req) => {
      const found = await store.departmentPolicy(req.params.tid, req.params.did);
      if (!found) throw Errors.notFound();
      return found;
    },
  );

  app.put(
    `${prefix}/tenants/:tid/departments/:did/policy`,
    {
      config: { access },
      schema: {
        summary: "Set a department's stricter rules",
        security: secured,
        params: TenantParams.extend({ did: z.string().uuid() }),
        body: OverrideSchema,
        response: {
          200: z.object({ override: OverrideSchema, company: PolicySchema }),
          ...errors,
        },
      },
    },
    async (req) => {
      const current = await store.departmentPolicy(req.params.tid, req.params.did);
      if (!current) throw Errors.notFound();
      const why = looserThan(current.company, req.body);
      if (why) throw Errors.badRequest(why);
      const saved = await store.saveDepartmentPolicy(
        req.params.tid,
        req.params.did,
        req.body,
        actorOf(callerOf(req)),
      );
      if (!saved) throw Errors.notFound();
      await Promise.resolve(events && publishPolicyChanged(events, req.params.tid)).catch(
        (e: Error) => log.warn({ err: { name: e.name } }, 'could not announce the policy change'),
      );
      return saved;
    },
  );

  app.put(
    `${prefix}/tenants/:tid/policy`,
    {
      config: { access },
      schema: {
        summary: "Change the company's policy",
        security: secured,
        params: TenantParams,
        body: z.object({ policy: PolicySchema, version: z.number().int() }),
        response: { 200: ResponseSchema, ...errors },
      },
    },
    async (req) => {
      const { policy, version } = req.body;
      if (!Object.values(policy.aliases).some(Boolean)) {
        throw Errors.badRequest('At least one model alias must stay on');
      }
      const saved = await store.savePolicy(req.params.tid, policy, version, actorOf(callerOf(req)));
      if (!saved) throw Errors.notFound();
      // After the commit. If this fails, the gateway's cache still expires within 30 s.
      await Promise.resolve(events && publishPolicyChanged(events, req.params.tid)).catch(
        (e: Error) => log.warn({ err: { name: e.name } }, 'could not announce the policy change'),
      );
      return saved;
    },
  );
}
