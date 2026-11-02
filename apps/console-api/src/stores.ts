// SPDX-License-Identifier: AGPL-3.0-only
// Governance data for the console. Connects as katip_console, which row-level security
// binds, so tenant data is only reachable inside withTenant (LLD-05 §1).
import { randomUUID } from 'node:crypto';
import * as schema from '@katip/db';
import { Errors } from '@katip/shared';
import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

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

export interface ConsoleStore {
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
  ): Promise<void> {
    await tx.insert(schema.auditLog).values({
      id: randomUUID(),
      tenantId,
      actorType: actor.type,
      actorId: actor.id,
      action,
      targetType: 'user',
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

  async ready(): Promise<boolean> {
    await this.db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
    return true;
  }
}
