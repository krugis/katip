// SPDX-License-Identifier: AGPL-3.0-only
// Governance data for the console. Connects as katip_console, which row-level security
// binds, so tenant data is only reachable inside withTenant (LLD-05 §1).
import { randomUUID } from 'node:crypto';
import * as schema from '@katip/db';
import { DEFAULT_POLICY } from '@katip/policy-engine';
import { Errors } from '@katip/shared';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { PolicyDocument } from './policy.js';

export interface TenantRecord {
  id: string;
  slug: string;
  name: string;
  status: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
}

export interface ManagedUser extends UserRecord {
  departmentId: string | null;
  seatPlanCode: string | null;
  lastSeenAt: Date | null;
}

export interface Actor {
  type: 'user' | 'provider';
  id: string;
}

export interface NewUserInput {
  email: string;
  name: string;
  role: string;
  departmentId: string | null;
  /** null: the company's seat plan. */
  seatPlanCode: string | null;
}

export interface UserChange {
  name?: string;
  role?: string;
  departmentId?: string | null;
  seatPlanCode?: string;
  status?: string;
}

export interface Overview {
  month: string;
  seats: { planCode: string; quantity: number; used: number }[];
  limits: { standard: number; premium: number; research: number } | null;
  used: { standard: number; premium: number; research: number };
}

export interface Department {
  id: string;
  name: string;
  budgetUsdMicro: number | null;
  managerIds: string[];
  userCount: number;
}

export interface DepartmentChange {
  name?: string;
  budgetUsdMicro?: number | null;
  managerIds?: string[];
}

/** Rows by number and reason only: the job outlives the import, and holds no addresses. */
export interface ImportProgress {
  total: number;
  created: number;
  skipped: number;
  notInvited: number;
  failed: { row: number; reason: string }[];
}

export interface ImportJob extends ImportProgress {
  id: string;
  status: 'running' | 'done' | 'failed' | 'interrupted';
}

/** A running import that hasn't moved for this long lost its process. */
const STALE_IMPORT_MS = 5 * 60_000;
const IMPORT_JOB = 'users.import';

export interface PolicyView {
  policy: PolicyDocument;
  version: number;
  kvkkAddon: boolean;
  catalog: { id: string; displayName: string; class: string; region: string; dataPolicy: string }[];
}

export interface AccessRulesInput {
  ipAllowlist: string[];
  countries: string[];
  sessionIdleMin: number;
  sessionMaxH: number;
}

export interface AccessRulesView extends AccessRulesInput {
  mfaRequired: boolean;
}

export type UsageGroup = 'user' | 'dept' | 'model' | 'day';

export interface UsageRow {
  /** What it's grouped by. Null only for "no department". */
  key: string | null;
  label: string;
  standard: number;
  premium: number;
  total: number;
}

export interface ConsoleStore {
  /** Inclusive UTC days. */
  usage(tenantId: string, group: UsageGroup, from: string, to: string): Promise<UsageRow[]>;
  accessRules(tenantId: string): Promise<AccessRulesView | null>;
  /** If `applyIdentity` throws, nothing changes. */
  saveAccessRules(
    tenantId: string,
    input: AccessRulesInput,
    actor: Actor,
    applyIdentity: () => Promise<void>,
  ): Promise<AccessRulesView>;
  /** Every company's allowlist, for Traefik. */
  allIpAllowlists(): Promise<{ slug: string; ipAllowlist: string[] }[]>;
  policy(tenantId: string): Promise<PolicyView | null>;
  /** null: no such company. Throws if someone else saved since `version` was read. */
  savePolicy(
    tenantId: string,
    policy: PolicyDocument,
    version: number,
    actor: Actor,
  ): Promise<PolicyView | null>;
  overview(tenantId: string, month: string): Promise<Overview>;
  listDepartments(tenantId: string): Promise<Department[]>;
  createDepartment(
    tenantId: string,
    input: { name: string; budgetUsdMicro: number | null },
    actor: Actor,
  ): Promise<Department>;
  updateDepartment(
    tenantId: string,
    id: string,
    change: DepartmentChange,
    actor: Actor,
  ): Promise<Department | null>;
  startImport(tenantId: string, total: number, actor: Actor): Promise<string>;
  recordImport(
    tenantId: string,
    id: string,
    progress: ImportProgress,
    done: boolean,
  ): Promise<void>;
  failImport(tenantId: string, id: string): Promise<void>;
  importJob(tenantId: string, id: string): Promise<ImportJob | null>;
  listUsers(tenantId: string): Promise<ManagedUser[]>;
  userById(tenantId: string, id: string): Promise<ManagedUser | null>;
  departmentIdByName(tenantId: string, name: string): Promise<string | null>;
  /**
   * Adds a user, holding the company's seat count steady while `ensureIdentity` runs. If it
   * throws, nothing is added.
   */
  createUser(
    tenantId: string,
    input: NewUserInput,
    actor: Actor,
    ensureIdentity: () => Promise<string>,
  ): Promise<ManagedUser>;
  /** Changes a user. If `applyIdentity` throws, nothing changes. */
  updateUser(
    tenantId: string,
    id: string,
    change: UserChange,
    actor: Actor,
    applyIdentity: (current: ManagedUser) => Promise<void>,
  ): Promise<ManagedUser>;
  tenantBySlug(slug: string): Promise<TenantRecord | null>;
  tenantById(id: string): Promise<TenantRecord | null>;
  listTenants(): Promise<TenantRecord[]>;
  findUser(tenantId: string, email: string): Promise<UserRecord | null>;
  /** True when the database is reachable and migrated. */
  ready(): Promise<boolean>;
}

type Db = ReturnType<typeof drizzle<typeof schema>>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const tenantColumns = {
  id: schema.tenants.id,
  slug: schema.tenants.slug,
  name: schema.tenants.name,
  status: schema.tenants.status,
};

const managedColumns = {
  id: schema.users.id,
  email: schema.users.email,
  name: schema.users.name,
  role: schema.users.role,
  status: schema.users.status,
  departmentId: schema.users.departmentId,
  seatPlanCode: schema.users.seatPlanCode,
  lastSeenAt: schema.users.lastSeenAt,
};

export class DbConsoleStore implements ConsoleStore {
  private readonly db;

  constructor(databaseUrl: string) {
    this.db = drizzle(postgres(databaseUrl, { max: 5, prepare: false }), { schema });
  }

  async close(): Promise<void> {
    await this.db.$client.end();
  }

  async tenantBySlug(slug: string): Promise<TenantRecord | null> {
    const rows = await this.db
      .select(tenantColumns)
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    return rows[0] ?? null;
  }

  async tenantById(id: string): Promise<TenantRecord | null> {
    const rows = await this.db
      .select(tenantColumns)
      .from(schema.tenants)
      .where(eq(schema.tenants.id, id));
    return rows[0] ?? null;
  }

  async listTenants(): Promise<TenantRecord[]> {
    return this.db.select(tenantColumns).from(schema.tenants).orderBy(asc(schema.tenants.slug));
  }

  async findUser(tenantId: string, email: string): Promise<UserRecord | null> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      const rows = await tx
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.users.role,
          status: schema.users.status,
        })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, email)));
      return rows[0] ?? null;
    });
  }

  /** Row-level security limits everything in here to this tenant. */
  private inTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx as unknown as Tx);
    });
  }

  /** One user change at a time per company, so parallel invites can't overrun the seats. */
  private lockTenant(tx: Tx, tenantId: string): Promise<unknown> {
    return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
  }

  /** The plan to use, if a seat is free on it. */
  private async takeSeat(tx: Tx, tenantId: string, wanted: string | null): Promise<string> {
    const seats = await tx
      .select({ planCode: schema.seats.planCode, quantity: schema.seats.quantity })
      .from(schema.seats)
      .where(eq(schema.seats.tenantId, tenantId))
      .orderBy(asc(schema.seats.planCode));
    const seat = wanted ? seats.find((s) => s.planCode === wanted) : seats[0];
    if (!seat) {
      if (wanted) throw Errors.badRequest('This company has no seats on that tier');
      throw Errors.conflict('no_seats', 'This company has no seats left');
    }
    const [used] = await tx
      .select({ n: count() })
      .from(schema.users)
      .where(
        and(
          eq(schema.users.tenantId, tenantId),
          eq(schema.users.seatPlanCode, seat.planCode),
          eq(schema.users.status, 'active'),
        ),
      );
    if ((used?.n ?? 0) >= seat.quantity) {
      throw Errors.conflict('no_seats', 'This company has no seats left');
    }
    return seat.planCode;
  }

  private async requireDepartment(tx: Tx, tenantId: string, id: string | null | undefined) {
    if (!id) return;
    const rows = await tx
      .select({ id: schema.departments.id })
      .from(schema.departments)
      .where(and(eq(schema.departments.tenantId, tenantId), eq(schema.departments.id, id)));
    if (rows.length === 0) throw Errors.badRequest('Unknown department');
  }

  private async audit(
    tx: Tx,
    tenantId: string,
    actor: Actor,
    action: string,
    targetId: string,
    details: Record<string, unknown>,
    targetType = 'user',
  ): Promise<void> {
    await tx.insert(schema.auditLog).values({
      id: randomUUID(),
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      targetType,
      targetId,
      details,
    });
  }

  async listUsers(tenantId: string): Promise<ManagedUser[]> {
    return this.inTenant(tenantId, (tx) =>
      tx
        .select(managedColumns)
        .from(schema.users)
        .where(eq(schema.users.tenantId, tenantId))
        .orderBy(asc(schema.users.email)),
    );
  }

  async userById(tenantId: string, id: string): Promise<ManagedUser | null> {
    const rows = await this.inTenant(tenantId, (tx) =>
      tx
        .select(managedColumns)
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, id))),
    );
    return rows[0] ?? null;
  }

  async departmentIdByName(tenantId: string, name: string): Promise<string | null> {
    const rows = await this.inTenant(tenantId, (tx) =>
      tx
        .select({ id: schema.departments.id })
        .from(schema.departments)
        .where(and(eq(schema.departments.tenantId, tenantId), eq(schema.departments.name, name))),
    );
    return rows[0]?.id ?? null;
  }

  async createUser(
    tenantId: string,
    input: NewUserInput,
    actor: Actor,
    ensureIdentity: () => Promise<string>,
  ): Promise<ManagedUser> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const existing = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.email, input.email)));
      if (existing.length > 0) {
        throw Errors.conflict('user_exists', 'This user is already in the company');
      }
      const seatPlanCode = await this.takeSeat(tx, tenantId, input.seatPlanCode);
      await this.requireDepartment(tx, tenantId, input.departmentId);
      const keycloakId = await ensureIdentity();
      const [user] = await tx
        .insert(schema.users)
        .values({
          tenantId,
          keycloakId,
          email: input.email,
          name: input.name,
          role: input.role,
          departmentId: input.departmentId,
          seatPlanCode,
          status: 'active',
        })
        .returning(managedColumns);
      // Ids and settings only: no names or email addresses in the audit log.
      await this.audit(tx, tenantId, actor, 'user.invite', user!.id, {
        role: input.role,
        seatPlanCode,
      });
      return user!;
    });
  }

  async updateUser(
    tenantId: string,
    id: string,
    change: UserChange,
    actor: Actor,
    applyIdentity: (current: ManagedUser) => Promise<void>,
  ): Promise<ManagedUser> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const [current] = await tx
        .select(managedColumns)
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, id)));
      if (!current) throw Errors.notFound();

      const losesAdmin =
        current.role === 'tenant_admin' &&
        current.status === 'active' &&
        (change.status === 'disabled' || (change.role && change.role !== 'tenant_admin'));
      if (losesAdmin) {
        const [others] = await tx
          .select({ n: count() })
          .from(schema.users)
          .where(
            and(
              eq(schema.users.tenantId, tenantId),
              eq(schema.users.role, 'tenant_admin'),
              eq(schema.users.status, 'active'),
              ne(schema.users.id, id),
            ),
          );
        if ((others?.n ?? 0) === 0) {
          throw Errors.conflict('last_admin', 'A company must keep at least one active admin');
        }
      }

      const activating = change.status === 'active' && current.status !== 'active';
      const movingTier = change.seatPlanCode && change.seatPlanCode !== current.seatPlanCode;
      const staysActive = (change.status ?? current.status) === 'active';
      if (staysActive && (activating || movingTier)) {
        await this.takeSeat(tx, tenantId, change.seatPlanCode ?? current.seatPlanCode);
      }
      await this.requireDepartment(tx, tenantId, change.departmentId);

      await applyIdentity(current);

      const [user] = await tx
        .update(schema.users)
        .set({ ...change, updatedAt: new Date() })
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.id, id)))
        .returning(managedColumns);
      const { name, ...settings } = change;
      await this.audit(tx, tenantId, actor, 'user.update', id, {
        ...settings,
        ...(name === undefined ? {} : { nameChanged: true }),
      });
      return user!;
    });
  }

  async overview(tenantId: string, month: string): Promise<Overview> {
    return this.inTenant(tenantId, async (tx) => {
      const seats = await tx
        .select({ planCode: schema.seats.planCode, quantity: schema.seats.quantity })
        .from(schema.seats)
        .where(eq(schema.seats.tenantId, tenantId))
        .orderBy(asc(schema.seats.planCode));
      const used = await tx
        .select({ planCode: schema.users.seatPlanCode, n: count() })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.status, 'active')))
        .groupBy(schema.users.seatPlanCode);
      const [limits] = await tx
        .select({
          standard: schema.tenantLimits.stdTokens,
          premium: schema.tenantLimits.premTokens,
          research: schema.tenantLimits.researchRuns,
        })
        .from(schema.tenantLimits)
        .where(
          and(eq(schema.tenantLimits.tenantId, tenantId), eq(schema.tenantLimits.month, month)),
        );
      const start = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)) - 1, 1));
      const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4)), 1));
      // As the gateway counts it: input plus output, with premium apart from the rest.
      const [totals] = await tx
        .select({
          premium: sql<string>`coalesce(sum(case when ${schema.usageEvents.class} = 'premium' then ${schema.usageEvents.inputTokens} + ${schema.usageEvents.outputTokens} end), 0)`,
          standard: sql<string>`coalesce(sum(case when ${schema.usageEvents.class} <> 'premium' then ${schema.usageEvents.inputTokens} + ${schema.usageEvents.outputTokens} end), 0)`,
          research: sql<string>`count(*) filter (where ${schema.usageEvents.source} = 'research')`,
        })
        .from(schema.usageEvents)
        .where(
          and(
            eq(schema.usageEvents.tenantId, tenantId),
            sql`${schema.usageEvents.ts} >= ${start.toISOString()}::timestamptz`,
            sql`${schema.usageEvents.ts} < ${end.toISOString()}::timestamptz`,
          ),
        );
      return {
        month,
        seats: seats.map((seat) => ({
          ...seat,
          used: used.find((u) => u.planCode === seat.planCode)?.n ?? 0,
        })),
        limits: limits ?? null,
        used: {
          standard: Number(totals?.standard ?? 0),
          premium: Number(totals?.premium ?? 0),
          research: Number(totals?.research ?? 0),
        },
      };
    });
  }

  private async departmentRows(tx: Tx, tenantId: string, only?: string): Promise<Department[]> {
    const rows = await tx
      .select({
        id: schema.departments.id,
        name: schema.departments.name,
        budgetUsdMicro: schema.departments.budgetUsdMicro,
      })
      .from(schema.departments)
      .where(
        and(
          eq(schema.departments.tenantId, tenantId),
          only ? eq(schema.departments.id, only) : undefined,
        ),
      )
      .orderBy(asc(schema.departments.name));
    const managers = await tx
      .select({
        departmentId: schema.departmentManagers.departmentId,
        userId: schema.departmentManagers.userId,
      })
      .from(schema.departmentManagers)
      .where(eq(schema.departmentManagers.tenantId, tenantId));
    const people = await tx
      .select({ departmentId: schema.users.departmentId, n: count() })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.status, 'active')))
      .groupBy(schema.users.departmentId);
    return rows.map((d) => ({
      ...d,
      managerIds: managers.filter((m) => m.departmentId === d.id).map((m) => m.userId),
      userCount: people.find((p) => p.departmentId === d.id)?.n ?? 0,
    }));
  }

  listDepartments(tenantId: string): Promise<Department[]> {
    return this.inTenant(tenantId, (tx) => this.departmentRows(tx, tenantId));
  }

  /** Departments are named once per company. */
  private async refuseTakenName(tx: Tx, tenantId: string, name: string, except?: string) {
    const taken = await tx
      .select({ id: schema.departments.id })
      .from(schema.departments)
      .where(
        and(
          eq(schema.departments.tenantId, tenantId),
          eq(schema.departments.name, name),
          except ? ne(schema.departments.id, except) : undefined,
        ),
      );
    if (taken.length > 0) {
      throw Errors.conflict('department_exists', 'A department with this name already exists');
    }
  }

  async createDepartment(
    tenantId: string,
    input: { name: string; budgetUsdMicro: number | null },
    actor: Actor,
  ): Promise<Department> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      await this.refuseTakenName(tx, tenantId, input.name);
      const [row] = await tx
        .insert(schema.departments)
        .values({ tenantId, name: input.name, budgetUsdMicro: input.budgetUsdMicro })
        .returning({ id: schema.departments.id });
      await this.audit(tx, tenantId, actor, 'department.create', row!.id, {}, 'department');
      const [department] = await this.departmentRows(tx, tenantId, row!.id);
      return department!;
    });
  }

  async updateDepartment(
    tenantId: string,
    id: string,
    change: DepartmentChange,
    actor: Actor,
  ): Promise<Department | null> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const [existing] = await tx
        .select({ id: schema.departments.id })
        .from(schema.departments)
        .where(and(eq(schema.departments.tenantId, tenantId), eq(schema.departments.id, id)));
      if (!existing) return null;

      const fields: { name?: string; budgetUsdMicro?: number | null } = {};
      if (change.name !== undefined) {
        await this.refuseTakenName(tx, tenantId, change.name, id);
        fields.name = change.name;
      }
      if (change.budgetUsdMicro !== undefined) fields.budgetUsdMicro = change.budgetUsdMicro;
      if (Object.keys(fields).length > 0) {
        await tx.update(schema.departments).set(fields).where(eq(schema.departments.id, id));
      }

      if (change.managerIds) {
        const wanted = [...new Set(change.managerIds)];
        // Only this company's active managers: row-level security hides everyone else anyway.
        const valid =
          wanted.length === 0
            ? []
            : await tx
                .select({ id: schema.users.id })
                .from(schema.users)
                .where(
                  and(
                    eq(schema.users.tenantId, tenantId),
                    eq(schema.users.role, 'dept_manager'),
                    eq(schema.users.status, 'active'),
                    inArray(schema.users.id, wanted),
                  ),
                );
        if (valid.length !== wanted.length) {
          throw Errors.badRequest('A manager must be an active department manager of this company');
        }
        await tx
          .delete(schema.departmentManagers)
          .where(eq(schema.departmentManagers.departmentId, id));
        if (wanted.length > 0) {
          await tx
            .insert(schema.departmentManagers)
            .values(wanted.map((userId) => ({ tenantId, departmentId: id, userId })));
        }
      }
      await this.audit(
        tx,
        tenantId,
        actor,
        'department.update',
        id,
        {
          ...(change.budgetUsdMicro === undefined ? {} : { budgetUsdMicro: change.budgetUsdMicro }),
          ...(change.managerIds ? { managerIds: change.managerIds } : {}),
          ...(change.name === undefined ? {} : { nameChanged: true }),
        },
        'department',
      );
      const [department] = await this.departmentRows(tx, tenantId, id);
      return department!;
    });
  }

  async usage(tenantId: string, group: UsageGroup, from: string, to: string): Promise<UsageRow[]> {
    return this.inTenant(tenantId, async (tx) => {
      await tx.execute(
        sql`select refresh_usage_daily(${tenantId}::uuid, ${from}::date, ${to}::date)`,
      );
      const d = schema.usageDaily;
      const key = {
        user: sql`${d.userId}::text`,
        dept: sql`${d.departmentId}::text`,
        model: sql`${d.modelId}`,
        day: sql`to_char(${d.day}, 'YYYY-MM-DD')`,
      }[group];
      const rows = (await tx
        .select({
          key: sql<string | null>`${key}`.as('key'),
          premium: sql<string>`coalesce(sum(${d.inputTokens} + ${d.outputTokens}) filter (where ${d.class} = 'premium'), 0)`,
          standard: sql<string>`coalesce(sum(${d.inputTokens} + ${d.outputTokens}) filter (where ${d.class} <> 'premium'), 0)`,
        })
        .from(d)
        .where(
          and(
            eq(d.tenantId, tenantId),
            sql`${d.day} >= ${from}::date`,
            sql`${d.day} <= ${to}::date`,
          ),
        )
        .groupBy(key)) as { key: string | null; premium: string; standard: string }[];

      const ids = rows.map((r) => r.key).filter((k): k is string => k !== null);
      const labels = new Map<string, string>();
      if (group === 'user' && ids.length > 0) {
        const people = await tx
          .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
          .from(schema.users)
          .where(and(eq(schema.users.tenantId, tenantId), inArray(schema.users.id, ids)));
        for (const p of people) labels.set(p.id, `${p.name} (${p.email})`);
      } else if (group === 'dept' && ids.length > 0) {
        const departments = await tx
          .select({ id: schema.departments.id, name: schema.departments.name })
          .from(schema.departments)
          .where(
            and(eq(schema.departments.tenantId, tenantId), inArray(schema.departments.id, ids)),
          );
        for (const dep of departments) labels.set(dep.id, dep.name);
      } else if (group === 'model' && ids.length > 0) {
        const models = await tx
          .select({ id: schema.modelCatalog.id, name: schema.modelCatalog.displayName })
          .from(schema.modelCatalog)
          .where(inArray(schema.modelCatalog.id, ids));
        for (const m of models) labels.set(m.id, m.name);
      }

      const out = rows.map((r) => {
        const standard = Number(r.standard);
        const premium = Number(r.premium);
        return {
          key: r.key,
          label: (r.key && labels.get(r.key)) ?? r.key ?? '',
          standard,
          premium,
          total: standard + premium,
        };
      });
      return group === 'day'
        ? out.sort((x, y) => (x.key ?? '').localeCompare(y.key ?? ''))
        : out.sort((x, y) => y.total - x.total);
    });
  }

  private async accessRulesOf(tx: Tx, tenantId: string): Promise<AccessRulesView> {
    const [row] = await tx
      .select({
        ipAllowlist: schema.accessRules.ipAllowlist,
        countries: schema.accessRules.countries,
        mfaRequired: schema.accessRules.mfaRequired,
        sessionIdleMin: schema.accessRules.sessionIdleMin,
        sessionMaxH: schema.accessRules.sessionMaxH,
      })
      .from(schema.accessRules)
      .where(eq(schema.accessRules.tenantId, tenantId));
    // Within what Keycloak's realm allows, whatever an older row says.
    const fit = (r: AccessRulesView) => ({
      ...r,
      sessionIdleMin: Math.min(r.sessionIdleMin, 30),
      sessionMaxH: Math.min(r.sessionMaxH, 10),
    });
    return fit(
      row ?? {
        ipAllowlist: [],
        countries: ['TR'],
        mfaRequired: true,
        sessionIdleMin: 30,
        sessionMaxH: 10,
      },
    );
  }

  async accessRules(tenantId: string): Promise<AccessRulesView | null> {
    if (!(await this.tenantById(tenantId))) return null;
    return this.inTenant(tenantId, (tx) => this.accessRulesOf(tx, tenantId));
  }

  async saveAccessRules(
    tenantId: string,
    input: AccessRulesInput,
    actor: Actor,
    applyIdentity: () => Promise<void>,
  ): Promise<AccessRulesView> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      await applyIdentity();
      const now = new Date();
      await tx
        .insert(schema.accessRules)
        .values({ tenantId, ...input, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.accessRules.tenantId,
          set: { ...input, updatedAt: now },
        });
      // Counts, not the addresses: an address can identify a person.
      await this.audit(
        tx,
        tenantId,
        actor,
        'access_rules.update',
        tenantId,
        {
          ipRanges: input.ipAllowlist.length,
          countries: input.countries.length,
          sessionIdleMin: input.sessionIdleMin,
          sessionMaxH: input.sessionMaxH,
        },
        'access_rules',
      );
      return this.accessRulesOf(tx, tenantId);
    });
  }

  async allIpAllowlists(): Promise<{ slug: string; ipAllowlist: string[] }[]> {
    const tenants = await this.listTenants();
    // One at a time: row-level security gives this role one company's rows at a time.
    const out: { slug: string; ipAllowlist: string[] }[] = [];
    for (const tenant of tenants) {
      const rows = await this.inTenant(tenant.id, (tx) =>
        tx
          .select({ ipAllowlist: schema.accessRules.ipAllowlist })
          .from(schema.accessRules)
          .where(eq(schema.accessRules.tenantId, tenant.id)),
      );
      out.push({ slug: tenant.slug, ipAllowlist: rows[0]?.ipAllowlist ?? [] });
    }
    return out;
  }

  private async policyView(tx: Tx, tenantId: string): Promise<PolicyView | null> {
    const [tenant] = await tx
      .select({ kvkkAddon: schema.tenants.kvkkAddon })
      .from(schema.tenants)
      .where(eq(schema.tenants.id, tenantId));
    if (!tenant) return null;
    const [row] = await tx
      .select({ policy: schema.tenantPolicies.policy, version: schema.tenantPolicies.version })
      .from(schema.tenantPolicies)
      .where(eq(schema.tenantPolicies.tenantId, tenantId));
    const stored = (row?.policy ?? {}) as Partial<PolicyDocument>;
    const catalog = await tx
      .select({
        id: schema.modelCatalog.id,
        displayName: schema.modelCatalog.displayName,
        class: schema.modelCatalog.class,
        region: schema.modelCatalog.region,
        dataPolicy: schema.modelCatalog.dataPolicy,
      })
      .from(schema.modelCatalog)
      .where(and(eq(schema.modelCatalog.enabled, true), ne(schema.modelCatalog.class, 'embedding')))
      .orderBy(asc(schema.modelCatalog.displayName));
    return {
      policy: {
        ...DEFAULT_POLICY,
        ...stored,
        pii: { mode: 'mask', ...stored.pii },
      } as PolicyDocument,
      version: row?.version ?? 0,
      kvkkAddon: tenant.kvkkAddon,
      // The Turkish model comes with the KVKK add-on.
      catalog: tenant.kvkkAddon ? catalog : catalog.filter((m) => m.class !== 'tr'),
    };
  }

  policy(tenantId: string): Promise<PolicyView | null> {
    return this.inTenant(tenantId, (tx) => this.policyView(tx, tenantId));
  }

  async savePolicy(
    tenantId: string,
    policy: PolicyDocument,
    version: number,
    actor: Actor,
  ): Promise<PolicyView | null> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const current = await this.policyView(tx, tenantId);
      if (!current) return null;
      if (current.version !== version) {
        throw Errors.conflict('policy_changed', 'Someone else changed this policy just now');
      }
      // Residency and the Turkish model are the KVKK add-on (LLD-04 §1.2).
      if (!current.kvkkAddon) {
        if (policy.aliases['tr-local'] || policy.residency !== 'ANY_APPROVED') {
          throw Errors.badRequest('This needs the KVKK add-on');
        }
      }
      const known = new Set(current.catalog.map((m) => m.id));
      if (policy.allowedModels.some((m) => !known.has(m))) {
        throw Errors.badRequest('Unknown model');
      }

      const next = version + 1;
      const now = new Date();
      const updatedBy = actor.type === 'user' ? actor.id : null;
      await tx
        .insert(schema.tenantPolicies)
        .values({ tenantId, policy, version: next, updatedBy, updatedAt: now })
        .onConflictDoUpdate({
          target: schema.tenantPolicies.tenantId,
          set: { policy, version: next, updatedBy, updatedAt: now },
        });
      await tx
        .insert(schema.policyHistory)
        .values({ tenantId, version: next, policy, changedBy: updatedBy });
      const changed = (Object.keys(policy) as (keyof PolicyDocument)[]).filter(
        (k) => JSON.stringify(policy[k]) !== JSON.stringify(current.policy[k]),
      );
      await this.audit(
        tx,
        tenantId,
        actor,
        'policy.update',
        tenantId,
        { version: next, changed, piiMode: policy.pii.mode },
        'policy',
      );
      return { ...current, policy, version: next };
    });
  }

  async startImport(tenantId: string, total: number, actor: Actor): Promise<string> {
    return this.inTenant(tenantId, async (tx) => {
      await this.lockTenant(tx, tenantId);
      const [latest] = await tx
        .select({ status: schema.jobs.status, updatedAt: schema.jobs.updatedAt })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.tenantId, tenantId), eq(schema.jobs.type, IMPORT_JOB)))
        .orderBy(desc(schema.jobs.createdAt))
        .limit(1);
      if (
        latest?.status === 'running' &&
        Date.now() - latest.updatedAt.getTime() < STALE_IMPORT_MS
      ) {
        throw Errors.conflict('import_running', 'An import is already running for this company');
      }
      const progress: ImportProgress = { total, created: 0, skipped: 0, notInvited: 0, failed: [] };
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          type: IMPORT_JOB,
          tenantId,
          status: 'running',
          payload: { actor: actor.id },
          result: progress,
        })
        .returning({ id: schema.jobs.id });
      return job!.id;
    });
  }

  async recordImport(
    tenantId: string,
    id: string,
    progress: ImportProgress,
    done: boolean,
  ): Promise<void> {
    await this.inTenant(tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({ result: progress, updatedAt: new Date(), ...(done ? { status: 'done' } : {}) })
        .where(and(eq(schema.jobs.tenantId, tenantId), eq(schema.jobs.id, id))),
    );
  }

  async failImport(tenantId: string, id: string): Promise<void> {
    await this.inTenant(tenantId, (tx) =>
      tx
        .update(schema.jobs)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(and(eq(schema.jobs.tenantId, tenantId), eq(schema.jobs.id, id))),
    );
  }

  async importJob(tenantId: string, id: string): Promise<ImportJob | null> {
    const rows = await this.inTenant(tenantId, (tx) =>
      tx
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          result: schema.jobs.result,
          updatedAt: schema.jobs.updatedAt,
        })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.tenantId, tenantId),
            eq(schema.jobs.id, id),
            eq(schema.jobs.type, IMPORT_JOB),
          ),
        ),
    );
    const row = rows[0];
    if (!row) return null;
    const stale =
      row.status === 'running' && Date.now() - row.updatedAt.getTime() >= STALE_IMPORT_MS;
    return {
      ...(row.result as ImportProgress),
      id: row.id,
      status: stale ? 'interrupted' : (row.status as ImportJob['status']),
    };
  }

  async ready(): Promise<boolean> {
    await this.db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
    return true;
  }
}
