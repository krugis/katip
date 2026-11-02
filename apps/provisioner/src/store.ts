// SPDX-License-Identifier: AGPL-3.0-only
// Governance data for provisioning. Connects as katip_provider: tenants are being created
// here, so no tenant context exists yet and it bypasses RLS by design (LLD-05 §1).
import { randomUUID } from 'node:crypto';
import * as schema from '@katip/db';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { TenantInput } from './provision.js';

/** Turkey and the EU (LLD-07 step 1). */
const DEFAULT_COUNTRIES =
  'TR AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');

export interface ProvisionerStore {
  ensureTenant(input: TenantInput): Promise<{ tenantId: string; created: boolean }>;
  hasTenantAdmin(tenantId: string): Promise<boolean>;
  addTenantAdmin(tenantId: string, keycloakId: string, input: TenantInput): Promise<void>;
  liveGatewayKeys(tenantId: string): Promise<{ keyHash: string }[]>;
  replaceGatewayKey(tenantId: string, keyHash: string, prefix: string): Promise<void>;
  audit(tenantId: string, slug: string, steps: string[]): Promise<void>;
  startJob(slug: string): Promise<string>;
  jobStep(jobId: string, step: string): Promise<void>;
  jobTenant(jobId: string, tenantId: string): Promise<void>;
  finishJob(jobId: string, result: { steps: string[] }): Promise<void>;
  failJob(jobId: string, step: string): Promise<void>;
}

const currentMonth = (now: Date): string =>
  `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

export class DbProvisionerStore implements ProvisionerStore {
  private readonly db;

  constructor(
    databaseUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.db = drizzle(postgres(databaseUrl, { max: 2, prepare: false, onnotice: () => {} }), {
      schema,
    });
  }

  async close(): Promise<void> {
    await this.db.$client.end();
  }

  async ensureTenant(input: TenantInput): Promise<{ tenantId: string; created: boolean }> {
    const existing = await this.db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, input.slug));
    if (existing[0]) return { tenantId: existing[0].id, created: false };

    const [plan] = await this.db
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.code, input.planCode))
      .orderBy(desc(schema.plans.version))
      .limit(1);
    if (!plan) throw new Error(`unknown plan ${input.planCode}`);

    // All or nothing, so "the tenant row exists" means this whole step is done.
    return this.db.transaction(async (tx) => {
      const [tenant] = await tx
        .insert(schema.tenants)
        .values({
          slug: input.slug,
          name: input.name,
          status: 'active',
          region: input.region,
          kvkkAddon: input.kvkkAddon,
        })
        .returning({ id: schema.tenants.id });
      const tenantId = tenant!.id;
      const now = this.now();
      const periodEnd = new Date(now);
      periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
      await tx.insert(schema.subscriptions).values({
        tenantId,
        billingCycle: 'monthly',
        status: 'active',
        periodStart: now,
        periodEnd,
      });
      await tx
        .insert(schema.seats)
        .values({ tenantId, planCode: input.planCode, quantity: input.seats });
      await tx
        .insert(schema.tenantPolicies)
        .values({ tenantId, policy: { pii: { mode: 'mask' } } });
      await tx.insert(schema.accessRules).values({
        tenantId,
        countries: DEFAULT_COUNTRIES,
        mfaRequired: true,
      });
      // A plan's quotas are per seat, pooled across the company.
      await tx.insert(schema.tenantLimits).values({
        tenantId,
        month: currentMonth(now),
        stdTokens: plan.stdTokens * input.seats,
        premTokens: plan.premTokens * input.seats,
        researchRuns: plan.researchRuns * input.seats,
      });
      return { tenantId, created: true };
    });
  }

  async hasTenantAdmin(tenantId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.role, 'tenant_admin')));
    return rows.length > 0;
  }

  async addTenantAdmin(tenantId: string, keycloakId: string, input: TenantInput): Promise<void> {
    await this.db.insert(schema.users).values({
      tenantId,
      keycloakId,
      email: input.adminEmail,
      name: input.adminEmail.split('@')[0]!,
      role: 'tenant_admin',
      seatPlanCode: input.planCode,
      status: 'active',
    });
  }

  async liveGatewayKeys(tenantId: string): Promise<{ keyHash: string }[]> {
    return this.db
      .select({ keyHash: schema.gatewayKeys.keyHash })
      .from(schema.gatewayKeys)
      .where(and(eq(schema.gatewayKeys.tenantId, tenantId), isNull(schema.gatewayKeys.revokedAt)));
  }

  async replaceGatewayKey(tenantId: string, keyHash: string, prefix: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.gatewayKeys)
        .set({ revokedAt: this.now() })
        .where(
          and(eq(schema.gatewayKeys.tenantId, tenantId), isNull(schema.gatewayKeys.revokedAt)),
        );
      await tx.insert(schema.gatewayKeys).values({ tenantId, keyHash, prefix, type: 'tenant' });
    });
  }

  async audit(tenantId: string, slug: string, steps: string[]): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      id: randomUUID(),
      tenantId,
      actorType: 'system',
      actorId: 'provisioner',
      action: 'tenant.create',
      targetType: 'tenant',
      targetId: slug,
      details: { steps },
    });
  }

  async startJob(slug: string): Promise<string> {
    const [job] = await this.db
      .insert(schema.jobs)
      .values({ type: 'tenant.create', status: 'running', payload: { slug } })
      .returning({ id: schema.jobs.id });
    return job!.id;
  }

  async jobStep(jobId: string, step: string): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ result: { step }, updatedAt: this.now() })
      .where(eq(schema.jobs.id, jobId));
  }

  async jobTenant(jobId: string, tenantId: string): Promise<void> {
    await this.db.update(schema.jobs).set({ tenantId }).where(eq(schema.jobs.id, jobId));
  }

  async finishJob(jobId: string, result: { steps: string[] }): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ status: 'done', result, updatedAt: this.now() })
      .where(eq(schema.jobs.id, jobId));
  }

  async failJob(jobId: string, step: string): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ status: 'failed', result: { step }, updatedAt: this.now() })
      .where(eq(schema.jobs.id, jobId));
  }
}
