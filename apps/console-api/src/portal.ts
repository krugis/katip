// SPDX-License-Identifier: AGPL-3.0-only
// What each person can see and ask for about themselves (LLD-04 §1.4, tracker P1-32), and
// where a company admin answers it. Everything under /me is the caller's own: no id is
// taken from the request, so there's no other person's id to try.
import { Errors } from '@katip/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Caller } from './auth.js';
import type { Actor, ConsoleStore } from './stores.js';
import { usageRange } from './usage.js';

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
const GROUPS = ['model', 'day'] as const;
const EXPORT_DAYS = 400;

const OwnRequest = z.object({
  id: z.string().uuid(),
  type: z.string(),
  reason: z.string(),
  status: z.string(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});
const AdminRequest = OwnRequest.extend({ userName: z.string(), userEmail: z.string() });
const PrivacyRequest = z.object({
  id: z.string().uuid(),
  type: z.string(),
  status: z.string(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

/** Where chats are, for the export: this service doesn't hold or read them. */
const CHATS_NOTE =
  'Chats are kept by LibreChat, and are not in this file. Export them from LibreChat, or ask your company admin.';

const actorOf = (caller: Caller): Actor =>
  caller.kind === 'provider'
    ? { type: 'provider', id: caller.sub }
    : { type: 'user', id: caller.user.id };

/** A provider admin has no account in a company, so has no "me" here. */
const person = (caller: Caller) => {
  if (caller.kind !== 'tenant') throw Errors.forbidden('This is for people in a company');
  return caller;
};

export function registerPortalRoutes(
  parent: FastifyInstance,
  store: ConsoleStore,
  prefix: string,
  callerOf: (req: FastifyRequest) => Caller,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const any = { roles: 'any' } as const;
  const admin = { roles: ['tenant_admin'], tenantParam: 'tid' } as const;

  app.get(
    `${prefix}/me/usage`,
    {
      config: { access: any },
      schema: {
        summary: "The caller's own tokens",
        security: secured,
        querystring: z.object({
          groupBy: z.enum(GROUPS).default('model'),
          from: Day.optional(),
          to: Day.optional(),
        }),
        response: {
          200: z.object({
            from: z.string(),
            to: z.string(),
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
      const caller = person(callerOf(req));
      const { from, to } = usageRange(req.query, new Date());
      const rows = await store.usage(
        caller.tenant.id,
        req.query.groupBy,
        from,
        to,
        undefined,
        caller.user.id,
      );
      return { from, to, rows };
    },
  );

  app.get(
    `${prefix}/me/requests`,
    {
      config: { access: any },
      schema: {
        summary: "The caller's own requests",
        security: secured,
        response: { 200: z.object({ requests: z.array(OwnRequest) }), ...errors },
      },
    },
    async (req) => {
      const caller = person(callerOf(req));
      return { requests: await store.ownRequests(caller.tenant.id, caller.user.id) };
    },
  );

  app.post(
    `${prefix}/me/requests`,
    {
      config: { access: any },
      schema: {
        summary: 'Ask for premium access, a higher budget or a new model',
        security: secured,
        body: z
          .object({
            type: z.enum(['premium_access', 'budget', 'model']),
            reason: z.string().trim().min(1).max(1000),
          })
          .strict(),
        response: { 201: OwnRequest, ...errors },
      },
    },
    async (req, reply) => {
      const caller = person(callerOf(req));
      const created = await store.createRequest(
        caller.tenant.id,
        caller.user.id,
        req.body.type,
        req.body.reason,
      );
      return reply.code(201).send(created);
    },
  );

  app.get(
    `${prefix}/me/privacy`,
    {
      config: { access: any },
      schema: {
        summary: "The caller's own privacy requests",
        security: secured,
        response: { 200: z.object({ requests: z.array(PrivacyRequest) }), ...errors },
      },
    },
    async (req) => {
      const caller = person(callerOf(req));
      return { requests: await store.ownPrivacyRequests(caller.tenant.id, caller.user.id) };
    },
  );

  app.post(
    `${prefix}/me/privacy/export`,
    {
      config: { access: any },
      schema: {
        summary: 'Everything this service holds about the caller, except chats',
        security: secured,
      },
    },
    async (req, reply) => {
      const caller = person(callerOf(req));
      const now = new Date();
      const from = new Date(now.getTime() - EXPORT_DAYS * 86_400_000).toISOString().slice(0, 10);
      const to = now.toISOString().slice(0, 10);
      const data = await store.exportOwnData(caller.tenant.id, caller.user.id, from, to);
      return reply
        .type('application/json; charset=utf-8')
        .header('content-disposition', 'attachment; filename="my-data.json"')
        .send({ exportedAt: now.toISOString(), chats: CHATS_NOTE, ...data });
    },
  );

  app.post(
    `${prefix}/me/privacy/delete`,
    {
      config: { access: any },
      schema: {
        summary: 'Ask for this account to be deleted: it goes to the company admin',
        security: secured,
        response: { 201: PrivacyRequest, ...errors },
      },
    },
    async (req, reply) => {
      const caller = person(callerOf(req));
      const created = await store.requestDeletion(caller.tenant.id, caller.user.id);
      return reply.code(201).send(created);
    },
  );

  app.get(
    `${prefix}/tenants/:tid/requests`,
    {
      config: { access: admin },
      schema: {
        summary: 'Everyone’s requests, including from people with no department',
        security: secured,
        params: TenantParams,
        response: {
          200: z.object({
            requests: z.array(AdminRequest),
            privacy: z.array(
              PrivacyRequest.extend({ userName: z.string(), userEmail: z.string() }),
            ),
          }),
          ...errors,
        },
      },
    },
    async (req) => ({
      requests: await store.allRequests(req.params.tid),
      privacy: await store.allPrivacyRequests(req.params.tid),
    }),
  );

  app.patch(
    `${prefix}/tenants/:tid/requests/:rid`,
    {
      config: { access: admin },
      schema: {
        summary: 'Approve or decline a request',
        security: secured,
        params: TenantParams.extend({ rid: z.string().uuid() }),
        body: z.object({ status: z.enum(['approved', 'rejected']) }).strict(),
        response: { 200: AdminRequest, ...errors },
      },
    },
    async (req) => {
      const caller = callerOf(req);
      const decided = await store.decideRequest(
        req.params.tid,
        null,
        req.params.rid,
        req.body.status,
        actorOf(caller),
        caller.kind === 'tenant' ? caller.user.id : null,
      );
      if (!decided) throw Errors.notFound();
      return decided;
    },
  );

  app.patch(
    `${prefix}/tenants/:tid/privacy-requests/:pid`,
    {
      config: { access: admin },
      schema: {
        summary: 'Mark a privacy request as handled',
        security: secured,
        params: TenantParams.extend({ pid: z.string().uuid() }),
        body: z.object({ status: z.literal('completed') }).strict(),
        response: { 200: PrivacyRequest, ...errors },
      },
    },
    async (req) => {
      const done = await store.completePrivacyRequest(
        req.params.tid,
        req.params.pid,
        actorOf(callerOf(req)),
      );
      if (!done) throw Errors.notFound();
      return done;
    },
  );
}
