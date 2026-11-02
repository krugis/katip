// SPDX-License-Identifier: AGPL-3.0-only
// A company's usage reports (LLD-04 §1.2, tracker P1-30). Tokens only: cost is our margin,
// and the console's database role can't read it.
import { Errors } from '@katip/shared';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ConsoleStore, UsageGroup, UsageRow } from './stores.js';

const MAX_DAYS = 400;
const DAY_MS = 86_400_000;
const GROUPS = ['user', 'dept', 'model', 'day'] as const;

const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number(),
  code: z.string(),
});
const errors = { 400: ProblemSchema, 401: ProblemSchema, 403: ProblemSchema, 404: ProblemSchema };
const secured = [{ bearerAuth: [] }];
const TenantParams = z.object({ tid: z.string().uuid() });
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Query = z.object({
  groupBy: z.enum(GROUPS).default('user'),
  from: Day.optional(),
  to: Day.optional(),
});

/** The range asked for, by default this UTC month so far. */
export function usageRange(query: { from?: string; to?: string }, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const from = query.from ?? `${today.slice(0, 7)}-01`;
  const to = query.to ?? today;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) throw Errors.badRequest('That is not a date');
  // Date.parse rolls 2026-02-31 over to March, so check it reads back the same.
  if (new Date(start).toISOString().slice(0, 10) !== from) {
    throw Errors.badRequest('That is not a date');
  }
  if (new Date(end).toISOString().slice(0, 10) !== to) {
    throw Errors.badRequest('That is not a date');
  }
  if (end < start) throw Errors.badRequest('The start is after the end');
  if ((end - start) / DAY_MS > MAX_DAYS) {
    throw Errors.badRequest(`A report can cover up to ${MAX_DAYS} days`);
  }
  return { from, to };
}

/** A cell Excel can't run: it treats text starting with these as a formula. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** With a byte order mark and semicolons, as Excel on a Turkish system expects. */
export function usageCsv(group: UsageGroup, rows: UsageRow[]): string {
  const header = [group, 'standard_tokens', 'premium_tokens', 'total_tokens'];
  const lines = [header, ...rows.map((r) => [r.label, r.standard, r.premium, r.total])];
  return `\uFEFF${lines.map((line) => line.map(csvCell).join(';')).join('\r\n')}\r\n`;
}

export function registerUsageRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  prefix: string,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const access = { roles: ['tenant_admin'], tenantParam: 'tid' } as const;

  app.get(
    `${prefix}/tenants/:tid/usage`,
    {
      config: { access },
      schema: {
        summary: "The company's tokens, by person, department, model or day",
        security: secured,
        params: TenantParams,
        querystring: Query,
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
      const { from, to } = usageRange(req.query, new Date());
      const { groupBy } = req.query;
      return { from, to, groupBy, rows: await store.usage(req.params.tid, groupBy, from, to) };
    },
  );

  app.get(
    `${prefix}/tenants/:tid/usage/export`,
    {
      config: { access },
      schema: {
        summary: 'The same report, as a CSV file',
        security: secured,
        params: TenantParams,
        querystring: Query,
      },
    },
    async (req, reply) => {
      const { from, to } = usageRange(req.query, new Date());
      const { groupBy } = req.query;
      const rows = await store.usage(req.params.tid, groupBy, from, to);
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="usage-${from}-${to}.csv"`)
        .send(usageCsv(groupBy, rows));
    },
  );
}
