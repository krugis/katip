// SPDX-License-Identifier: AGPL-3.0-only
// Users API (LLD-04 §2, tracker P1-24). Every route is limited to the caller's own tenant.
// A disabled user is refused at once: the gateway and this API read the status on each
// request, and there's no cache to clear.
import { AppError, Errors } from '@katip/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Caller } from './auth.js';
import { parseCsv } from './csv.js';
import type { IdentityClient, TenantRole } from './identity.js';
import type { Actor, ConsoleStore, ImportProgress, ManagedUser, TenantRecord } from './stores.js';

const ROLES = ['tenant_admin', 'dept_manager', 'user'] as const;
const MAX_IMPORT_ROWS = 1000;

const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.string(),
  status: z.string(),
  departmentId: z.string().uuid().nullable(),
  seatPlanCode: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
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
const UserParams = TenantParams.extend({ uid: z.string().uuid() });

const NewUser = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(200),
  role: z.enum(ROLES).default('user'),
  departmentId: z.string().uuid().nullish(),
  seatPlanCode: z.string().min(1).nullish(),
});

const UserPatch = z
  .object({
    name: z.string().trim().min(1).max(200),
    role: z.enum(ROLES),
    departmentId: z.string().uuid().nullable(),
    seatPlanCode: z.string().min(1),
    status: z.enum(['active', 'disabled']),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, 'nothing to change');

const present = (u: ManagedUser) => ({ ...u, lastSeenAt: u.lastSeenAt?.toISOString() ?? null });

const actorOf = (caller: Caller): Actor =>
  caller.kind === 'provider'
    ? { type: 'provider', id: caller.sub }
    : { type: 'user', id: caller.user.id };

export interface UserRouteDeps {
  store: ConsoleStore;
  identity: IdentityClient;
}

export function registerUserRoutes(
  parent: FastifyInstance,
  deps: UserRouteDeps,
  prefix: string,
  callerOf: (req: FastifyRequest) => Caller,
): void {
  const app = parent.withTypeProvider<ZodTypeProvider>();
  const { store, identity } = deps;
  const access = { roles: ['tenant_admin'], tenantParam: 'tid' } as const;

  const activeTenant = async (id: string): Promise<TenantRecord> => {
    const tenant = await store.tenantById(id);
    if (!tenant) throw Errors.notFound();
    if (tenant.status !== 'active') throw Errors.forbidden('This company is suspended');
    return tenant;
  };

  /** Adds the user, then emails them. If only the email fails, a resend can fix it. */
  const invite = async (
    req: FastifyRequest,
    tenant: TenantRecord,
    input: {
      email: string;
      name: string;
      role: TenantRole;
      departmentId: string | null;
      seatPlanCode: string | null;
    },
    actor: Actor,
  ) => {
    const user = await store.createUser(tenant.id, input, actor, async () => {
      const { keycloakId } = await identity.invite(tenant.slug, {
        email: input.email,
        name: input.name,
        role: input.role,
      });
      return keycloakId;
    });
    let invited = true;
    try {
      await identity.sendInvite(tenant.slug, input.email);
    } catch (e) {
      invited = false;
      req.log.warn({ err: { name: (e as Error).name }, userId: user.id }, 'invite email failed');
    }
    return { user, invited };
  };

  app.get(
    `${prefix}/tenants/:tid/users`,
    {
      config: { access },
      schema: {
        summary: "The company's users",
        security: secured,
        params: TenantParams,
        response: { 200: z.object({ users: z.array(UserSchema) }), ...errors },
      },
    },
    async (req) => {
      const users = await store.listUsers(req.params.tid);
      return { users: users.map(present) };
    },
  );

  app.post(
    `${prefix}/tenants/:tid/users`,
    {
      config: { access },
      schema: {
        summary: 'Invite a user',
        security: secured,
        params: TenantParams,
        body: NewUser,
        response: { 201: UserSchema.extend({ invited: z.boolean() }), ...errors },
      },
    },
    async (req, reply) => {
      const tenant = await activeTenant(req.params.tid);
      const { user, invited } = await invite(
        req,
        tenant,
        {
          ...req.body,
          email: req.body.email.toLowerCase(),
          departmentId: req.body.departmentId ?? null,
          seatPlanCode: req.body.seatPlanCode ?? null,
        },
        actorOf(callerOf(req)),
      );
      return reply.code(201).send({ ...present(user), invited });
    },
  );

  app.patch(
    `${prefix}/tenants/:tid/users/:uid`,
    {
      config: { access },
      schema: {
        summary: "Change a user's name, role, department or tier, or disable them",
        security: secured,
        params: UserParams,
        body: UserPatch,
        response: { 200: UserSchema, ...errors },
      },
    },
    async (req) => {
      const caller = callerOf(req);
      const tenant = await activeTenant(req.params.tid);
      const patch = req.body;
      // So a company can't lock itself out by accident.
      if (caller.kind === 'tenant' && caller.user.id === req.params.uid) {
        if (patch.status === 'disabled') throw Errors.badRequest('You cannot disable yourself');
        if (patch.role && patch.role !== caller.user.role) {
          throw Errors.badRequest('You cannot change your own role');
        }
      }
      const user = await store.updateUser(
        tenant.id,
        req.params.uid,
        patch,
        actorOf(caller),
        // Inside the transaction: if Keycloak fails, the database doesn't change either.
        async (current) => {
          if (patch.role && patch.role !== current.role) {
            await identity.setRole(tenant.slug, current.email, patch.role);
          }
          if (patch.status && patch.status !== current.status) {
            await identity.setEnabled(tenant.slug, current.email, patch.status === 'active');
          }
        },
      );
      return present(user);
    },
  );

  app.post(
    `${prefix}/tenants/:tid/users/:uid/invite`,
    {
      config: { access },
      schema: {
        summary: 'Send the invite email again',
        security: secured,
        params: UserParams,
        response: { 200: z.object({ invited: z.boolean() }), ...errors },
      },
    },
    async (req) => {
      const tenant = await activeTenant(req.params.tid);
      const user = await store.userById(tenant.id, req.params.uid);
      if (!user) throw Errors.notFound();
      if (user.status !== 'active') throw Errors.badRequest('This user is disabled');
      await identity.sendInvite(tenant.slug, user.email);
      return { invited: true };
    },
  );

  app.post(
    `${prefix}/tenants/:tid/users/import`,
    {
      config: { access },
      schema: {
        summary: 'Start inviting users from a CSV file: email, name, department, tier',
        security: secured,
        params: TenantParams,
        consumes: ['text/csv'],
        body: z.string().max(1_000_000),
        response: { 202: z.object({ id: z.string().uuid(), total: z.number() }), ...errors },
      },
    },
    async (req, reply) => {
      const tenant = await activeTenant(req.params.tid);
      const actor = actorOf(callerOf(req));
      let parsed: ReturnType<typeof parseCsv>;
      try {
        parsed = parseCsv(req.body);
      } catch {
        throw Errors.badRequest('This file could not be read as CSV');
      }
      for (const column of ['email', 'name']) {
        if (!parsed.columns.includes(column)) {
          throw Errors.badRequest(`The file needs a "${column}" column`);
        }
      }
      if (parsed.rows.length > MAX_IMPORT_ROWS) {
        throw Errors.badRequest(`A file can hold up to ${MAX_IMPORT_ROWS} users`);
      }
      const total = parsed.rows.length;
      const id = await store.startImport(tenant.id, total, actor);

      // In the background: a long file would outlast the request. A re-run after a crash is
      // safe, because users already in the company are skipped.
      void (async () => {
        const progress: ImportProgress = {
          total,
          created: 0,
          skipped: 0,
          notInvited: 0,
          failed: [],
        };
        // One row at a time, so a bad row costs only itself.
        for (const { row, values } of parsed.rows) {
          const email = (values['email'] ?? '').toLowerCase();
          const input = NewUser.safeParse({ email, name: values['name'] });
          if (!input.success) {
            progress.failed.push({ row, reason: 'invalid_row' });
          } else {
            try {
              const departmentId = values['department']
                ? await store.departmentIdByName(tenant.id, values['department'])
                : null;
              if (values['department'] && !departmentId) {
                progress.failed.push({ row, reason: 'unknown_department' });
              } else {
                const { invited } = await invite(
                  req,
                  tenant,
                  {
                    email,
                    name: input.data.name,
                    role: 'user',
                    departmentId,
                    seatPlanCode: values['tier'] || null,
                  },
                  actor,
                );
                progress.created += 1;
                if (!invited) progress.notInvited += 1;
              }
            } catch (e) {
              if (e instanceof AppError && e.code === 'user_exists') progress.skipped += 1;
              else if (e instanceof AppError) progress.failed.push({ row, reason: e.code });
              else throw e;
            }
          }
          await store.recordImport(tenant.id, id, progress, false);
        }
        await store.recordImport(tenant.id, id, progress, true);
      })().catch(async (e: Error) => {
        req.log.error({ err: { name: e.name }, importId: id }, 'import failed');
        await store.failImport(tenant.id, id).catch(() => undefined);
      });

      return reply.code(202).send({ id, total });
    },
  );

  app.get(
    `${prefix}/tenants/:tid/users/imports/:jid`,
    {
      config: { access },
      schema: {
        summary: 'How an import is going',
        security: secured,
        params: TenantParams.extend({ jid: z.string().uuid() }),
        response: {
          200: z.object({
            id: z.string().uuid(),
            status: z.enum(['running', 'done', 'failed', 'interrupted']),
            total: z.number(),
            created: z.number(),
            skipped: z.number(),
            notInvited: z.number(),
            failed: z.array(z.object({ row: z.number(), reason: z.string() })),
          }),
          ...errors,
        },
      },
    },
    async (req) => {
      const job = await store.importJob(req.params.tid, req.params.jid);
      if (!job) throw Errors.notFound();
      return job;
    },
  );
}
