// SPDX-License-Identifier: AGPL-3.0-only
// Governance data for the console. Connects as katip_console, which row-level security
// binds, so tenant data is only reachable inside withTenant (LLD-05 §1).
import * as schema from '@katip/db';
import { and, asc, eq, sql } from 'drizzle-orm';
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

export interface ConsoleStore {
  tenantBySlug(slug: string): Promise<TenantRecord | null>;
  tenantById(id: string): Promise<TenantRecord | null>;
  listTenants(): Promise<TenantRecord[]>;
  findUser(tenantId: string, email: string): Promise<UserRecord | null>;
  /** True when the database is reachable and migrated. */
  ready(): Promise<boolean>;
}

const tenantColumns = {
  id: schema.tenants.id,
  slug: schema.tenants.slug,
  name: schema.tenants.name,
  status: schema.tenants.status,
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

  async ready(): Promise<boolean> {
    await this.db.select({ id: schema.tenants.id }).from(schema.tenants).limit(1);
    return true;
  }
}
