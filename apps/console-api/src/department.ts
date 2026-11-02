// SPDX-License-Identifier: AGPL-3.0-only
// A department manager's area (LLD-04 §1.3, tracker P1-31). Their role isn't enough: each
// route also checks they manage that department, and any other answers 404, so they can't
// tell it exists. A company admin may see every department in the company.
import { Errors } from '@katip/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Caller } from './auth.js';
import type { Actor, ConsoleStore } from './stores.js';
import { usageCsv, usageRange } from './usage.js';

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});
const errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];
const TenantParams = z.object({ tid: z.string().uuid() });
const DepartmentParams = TenantParams.extend({ did: z.string().uuid() });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const GROUPS = ['user', 'model', 'day'] as const;
const UsageQuery = z.object({
  groupBy: z.enum(GROUPS).default('user'),
  from: Day.optional(),
  to: Day.optional(),
});

const RequestSchema = z.object({
  id: z.string().uuid(),
  type: z.string(),
  reason: z.string(),
  status: z.string(),
  userName: z.string(),
  userEmail: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

const actorOf = (caller: Caller): Actor =>
  caller.kind === 'provider'
    ? { type: 'provider', id: caller.sub }
    : { type: 'user', id: caller.user.id };

export function registerDepartmentRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  prefix: string,
  callerOf: (req: FastifyRequest) => Caller,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const access = { roles: ['tenant_admin', 'dept_manager'], tenantParam: 'tid' } as const;

  /** A tenant admin or provider sees them all; a manager only the ones they manage. */
  const managerId = (caller: Caller): string | null =>
    caller.kind === 'tenant' && !caller.roles.includes('tenant_admin') ? caller.user.id : null;

  /** 404 unless this caller may see this department. */
  const requireDepartment = async (req: FastifyRequest, tid: string, did: string) => {
    if (!(await store.canSeeDepartment(tid, did, managerId(callerOf(req))))) {
      throw Errors.notFound();
    }
  };

  app.get(
    `${prefix}/tenants/:tid/my-departments`,
    {
      config: { access },
      schema: {
        summary: 'The departments this caller may see',
        security: secured,
        params: TenantParams,
        response: {
          200: z.object({
            departments: z.array(
              z.object({
                id: z.string().uuid(),
                name: z.string(),
                budgetUsdMicro: z.number().nullable(),
                userCount: z.number(),
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const all = await store.listDepartments(req.params.tid);
      const manager = managerId(callerOf(req));
      const departments = manager ? all.filter((d) => d.managerIds.includes(manager)) : all;
      return {
        departments: departments.map(({ id, name, budgetUsdMicro, userCount }) => ({
          id,
          name,
          budgetUsdMicro,
          userCount,
        })),
      };
    },
  );

  app.get(
    `${prefix}/tenants/:tid/departments/:did/users`,
    {
      config: { access },
      schema: {
        summary: "A department's people",
        security: secured,
        params: DepartmentParams,
        response: {
          200: z.object({
            users: z.array(
              z.object({
                id: z.string().uuid(),
                email: z.string(),
                name: z.string(),
                role: z.string(),
                status: z.string(),
                seatPlanCode: z.string().nullable(),
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { tid, did } = req.params;
      await requireDepartment(req, tid, did);
      return { users: await store.departmentUsers(tid, did) };
    },
  );

  app.get(
    `${prefix}/tenants/:tid/departments/:did/usage`,
    {
      config: { access },
      schema: {
        summary: "A department's tokens, by person, model or day",
        security: secured,
        params: DepartmentParams,
        querystring: UsageQuery,
        response: {
          200: z.object({
            from: z.string(),
            to: z.string(),
            groupBy: z.enum(GROUPS),
            rows: z.array(
              z.object({
                key: z.string().nullable(),
                label: z.string(),
                standard: z.number(),
                premium: z.number(),
                total: z.number(),
              }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const { tid, did } = req.params;
      await requireDepartment(req, tid, did);
      const { from, to } = usageRange(req.query, new Date());
      const { groupBy } = req.query;
      return { from, to, groupBy, rows: await store.usage(tid, groupBy, from, to, did) };
    },
  );

  app.get(
    `${prefix}/tenants/:tid/departments/:did/usage/export`,
    {
      config: { access },
      schema: {
        summary: 'The same report, as a CSV file',
        security: secured,
        params: DepartmentParams,
        querystring: UsageQuery,
      },
    },
    async (req, reply) => {
      const { tid, did } = req.params;
      await requireDepartment(req, tid, did);
      const { from, to } = usageRange(req.query, new Date());
      const { groupBy } = req.query;
      const rows = await store.usage(tid, groupBy, from, to, did);
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="usage-${from}-${to}.csv"`)
        .send(usageCsv(groupBy, rows));
    },
  );

  app.get(
    `${prefix}/tenants/:tid/departments/:did/requests`,
    {
      config: { access },
      schema: {
        summary: 'Requests from people in this department',
        security: secured,
        params: DepartmentParams,
        response: { 200: z.object({ requests: z.array(RequestSchema) }), ...errors },
      },
    },
    async (req) => {
      const { tid, did } = req.params;
      await requireDepartment(req, tid, did);
      return { requests: await store.departmentRequests(tid, did) };
    },
  );

  app.patch(
    `${prefix}/tenants/:tid/departments/:did/requests/:rid`,
    {
      config: { access },
      schema: {
        summary: 'Approve or decline a request',
        security: secured,
        params: DepartmentParams.extend({ rid: z.string().uuid() }),
        body: z.object({ status: z.enum(['approved', 'rejected']) }).strict(),
        response: { 200: RequestSchema, ...errors },
      },
    },
    async (req) => {
      const { tid, did, rid } = req.params;
      await requireDepartment(req, tid, did);
      const caller = callerOf(req);
      // Nobody signs off their own request.
      const decided = await store.decideRequest(
        tid,
        did,
        rid,
        req.body.status,
        actorOf(caller),
        caller.kind === 'tenant' ? caller.user.id : null,
      );
      if (!decided) throw Errors.notFound();
      return decided;
    },
  );
}
