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
