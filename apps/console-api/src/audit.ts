// SPDX-License-Identifier: AGPL-3.0-only
// Reading the audit log (LLD-04, tracker P1-33). Newest first, a page at a time.
import { Errors } from '@katip/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ConsoleStore } from './stores.js';

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});
const errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];

const Query = z.object({
  action: z
    .string()
    .regex(/^[a-z_.]{1,60}$/)
    .optional(),
  /** Everything older than this: the `next` of the page before. */
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const Entry = z.object({
  id: z.string(),
  ts: z.string(),
  action: z.string(),
  actorType: z.string(),
  actor: z.string().nullable(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
const Page = z.object({ entries: z.array(Entry), next: z.string().nullable() });

export function registerAuditRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  prefix: string,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();

  app.get(
    `${prefix}/tenants/:tid/audit`,
    {
      config: { access: { roles: ['tenant_admin'], tenantParam: 'tid' } },
      schema: {
        summary: "The company's audit log",
        security: secured,
        params: z.object({ tid: z.string().uuid() }),
        querystring: Query,
        response: { 200: Page, ...errors },
      },
    },
    async (req) => {
      if (!(await store.tenantById(req.params.tid))) throw Errors.notFound();
      return store.auditPage(req.params.tid, req.query);
    },
  );

  app.get(
    `${prefix}/admin/audit`,
    {
      // No roles listed: only a provider admin gets through (auth.ts).
      config: { access: { roles: [] } },
      schema: {
        summary: 'Every company’s audit log (provider admins)',
        security: secured,
        querystring: Query.extend({ tenant: z.string().uuid().optional() }),
        response: {
          200: z.object({
            entries: z.array(Entry.extend({ tenantSlug: z.string() })),
            next: z.string().nullable(),
          }),
          ...errors,
        },
      },
    },
    async (req) => store.auditAcrossTenants(req.query),
  );
}
