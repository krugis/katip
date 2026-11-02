// SPDX-License-Identifier: AGPL-3.0-only
// A tenant admin's overview and departments (LLD-04 §1.2, tracker P1-26).
import { Errors } from '@katip/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Caller } from './auth.js';
import type { Actor, ConsoleStore } from './stores.js';

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});
const errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];
const TenantParams = z.object({ tid: z.string().uuid() });

const Budget = z.number().int().nonnegative().max(1_000_000_000_000).nullable();

const DepartmentSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  budgetUsdMicro: z.number().nullable(),
  managerIds: z.array(z.string().uuid()),
  userCount: z.number(),
});

const OverviewSchema = z.object({
  month: z.string(),
  seats: z.array(z.object({ planCode: z.string(), quantity: z.number(), used: z.number() })),
  limits: z.object({ standard: z.number(), premium: z.number(), research: z.number() }).nullable(),
  used: z.object({ standard: z.number(), premium: z.number(), research: z.number() }),
  alerts: z.array(z.object({ class: z.string(), threshold: z.number() })),
});

const actorOf = (caller: Caller): Actor =>
  caller.kind === 'provider'
    ? { type: 'provider', id: caller.sub }
    : { type: 'user', id: caller.user.id };

/** The month quotas count in: UTC, as the gateway has it. */
export const currentMonth = (now: Date): string =>
  `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

export function registerCompanyRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  prefix: string,
  callerOf: (req: FastifyRequest) => Caller,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const access = { roles: ['tenant_admin'], tenantParam: 'tid' } as const;

  app.get(
    `${prefix}/tenants/:tid/overview`,
    {
      config: { access },
      schema: {
        summary: 'Seats and this month’s quota use',
        security: secured,
        params: TenantParams,
        response: { 200: OverviewSchema, ...errors },
      },
    },
    async (req) => store.overview(req.params.tid, currentMonth(new Date())),
  );

  app.get(
    `${prefix}/tenants/:tid/departments`,
    {
      config: { access },
      schema: {
        summary: "The company's departments",
        security: secured,
        params: TenantParams,
        response: { 200: z.object({ departments: z.array(DepartmentSchema) }), ...errors },
      },
    },
    async (req) => ({ departments: await store.listDepartments(req.params.tid) }),
  );

  app.post(
    `${prefix}/tenants/:tid/departments`,
    {
      config: { access },
      schema: {
        summary: 'Create a department',
        security: secured,
        params: TenantParams,
        body: z.object({
          name: z.string().trim().min(1).max(200),
          budgetUsdMicro: Budget.optional(),
        }),
        response: { 201: DepartmentSchema, ...errors },
      },
    },
    async (req, reply) => {
      const department = await store.createDepartment(
        req.params.tid,
        { name: req.body.name, budgetUsdMicro: req.body.budgetUsdMicro ?? null },
        actorOf(callerOf(req)),
      );
      return reply.code(201).send(department);
    },
  );

  app.patch(
    `${prefix}/tenants/:tid/departments/:did`,
    {
      config: { access },
      schema: {
        summary: "Change a department's name, budget or managers",
        security: secured,
        params: TenantParams.extend({ did: z.string().uuid() }),
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            budgetUsdMicro: Budget,
            managerIds: z.array(z.string().uuid()).max(100),
          })
          .partial()
          .refine((p) => Object.keys(p).length > 0, 'nothing to change'),
        response: { 200: DepartmentSchema, ...errors },
      },
    },
    async (req) => {
      const department = await store.updateDepartment(
        req.params.tid,
        req.params.did,
        req.body,
        actorOf(callerOf(req)),
      );
      if (!department) throw Errors.notFound();
      return department;
    },
  );
}
