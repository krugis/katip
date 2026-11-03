// SPDX-License-Identifier: AGPL-3.0-only
// Governance data for provisioning. Connects as katip_provider: tenants are being created
// here, so no tenant context exists yet and it bypasses RLS by design (LLD-05 §1).
import { randomUUID } from 'node:crypto';
import * as schema from '@katip/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { TenantInput } from './provision.js';

/** Turkey and the EU (LLD-07 step 1). */
const DEFAULT_COUNTRIES =
  'TR AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE'.split(' ');

export interface FxRate {
  date: string;
  currency: string;
  buying: string;
  selling: string;
}

export interface PurgeJob {
  jobId: string;
  status: string;
  purgeAfter: string;
}

const PURGE_JOB = 'tenant.purge';

export interface ProvisionerStore {
  ensureTenant(input: TenantInput): Promise<{ tenantId: string; created: boolean }>;
  hasTenantAdmin(tenantId: string): Promise<boolean>;
  addTenantAdmin(tenantId: string, keycloakId: string, input: TenantInput): Promise<void>;
  liveGatewayKeys(tenantId: string): Promise<{ keyHash: string }[]>;
  replaceGatewayKey(tenantId: string, keyHash: string, prefix: string): Promise<void>;
  audit(tenantId: string, slug: string, steps: string[]): Promise<void>;
  tenantId(slug: string): Promise<string | null>;
  tenantHasUsers(slug: string): Promise<boolean>;
  tenantState(slug: string): Promise<{ id: string; status: string } | null>;
  setTenantStatus(id: string, status: string): Promise<void>;
  auditAction(
    tenantId: string,
    action: string,
    slug: string,
    details?: Record<string, unknown>,
  ): Promise<void>;
  latestPurge(slug: string): Promise<PurgeJob | null>;
  schedulePurge(tenantId: string, slug: string, purgeAfter: string): Promise<void>;
  cancelPurge(jobId: string): Promise<void>;
  markPurgeRunning(jobId: string): Promise<void>;
  duePurges(now: Date): Promise<string[]>;
  anonymiseTenant(tenantId: string): Promise<void>;
  saveFxRate(rate: FxRate): Promise<boolean>;
  enforceRetention(): Promise<{ usage: number; usageDaily: number; audit: number }>;
  recordDailyRun(details: Record<string, unknown>): Promise<void>;
  deletionsDue(): Promise<{ slug: string; requestId: string }[]>;
  deletionSubject(
    slug: string,
    requestId: string,
  ): Promise<{ tenantId: string; userId: string; email: string; keycloakId: string } | null>;
  forgetUser(tenantId: string, userId: string, requestId: string, slug: string): Promise<void>;
  startJob(slug: string, type: string): Promise<string>;
  jobStep(jobId: string, step: string): Promise<void>;
  jobTenant(jobId: string, tenantId: string): Promise<void>;
  finishJob(jobId: string, result: Record<string, unknown>): Promise<void>;
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
    const existing = await this.tenantState(input.slug);
    if (existing) {
      if (existing.status !== 'active') {
        throw new Error(`tenant ${input.slug} is ${existing.status}`);
      }
      return { tenantId: existing.id, created: false };
    }

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

  async tenantId(slug: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: schema.tenants.id })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    return rows[0]?.id ?? null;
  }

  async tenantHasUsers(slug: string): Promise<boolean> {
    const id = await this.tenantId(slug);
    if (!id) return false;
    const rows = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.tenantId, id))
      .limit(1);
    return rows.length > 0;
  }

  async tenantState(slug: string): Promise<{ id: string; status: string } | null> {
    const rows = await this.db
      .select({ id: schema.tenants.id, status: schema.tenants.status })
      .from(schema.tenants)
      .where(eq(schema.tenants.slug, slug));
    return rows[0] ?? null;
  }

  // Raw SQL from here on: this role may change only these columns, not updated_at.
  async setTenantStatus(id: string, status: string): Promise<void> {
    await this.db.execute(sql`update tenants set status = ${status} where id = ${id}`);
  }

  async auditAction(
    tenantId: string,
    action: string,
    slug: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      id: randomUUID(),
      tenantId,
      actorType: 'system',
      actorId: 'provisioner',
      action,
      targetType: 'tenant',
      targetId: slug,
      details,
    });
  }

  private async purgeJobs(slug?: string): Promise<(PurgeJob & { slug: string })[]> {
    const rows = await this.db
      .select({ id: schema.jobs.id, status: schema.jobs.status, payload: schema.jobs.payload })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.type, PURGE_JOB),
          slug ? sql`${schema.jobs.payload}->>'slug' = ${slug}` : undefined,
        ),
      )
      .orderBy(desc(schema.jobs.createdAt));
    return rows.map((r) => {
      const payload = r.payload as { slug: string; purgeAfter: string };
      return { jobId: r.id, status: r.status, slug: payload.slug, purgeAfter: payload.purgeAfter };
    });
  }

  /** The tenant's purge, unless a restore cancelled it. */
  async latestPurge(slug: string): Promise<PurgeJob | null> {
    const [latest] = await this.purgeJobs(slug);
    return latest && latest.status !== 'cancelled' ? latest : null;
  }

  async schedulePurge(tenantId: string, slug: string, purgeAfter: string): Promise<void> {
    await this.db.insert(schema.jobs).values({
      type: PURGE_JOB,
      tenantId,
      status: 'pending',
      payload: { slug, purgeAfter },
    });
  }

  private async setJobStatus(jobId: string, status: string): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ status, updatedAt: this.now() })
      .where(eq(schema.jobs.id, jobId));
  }

  cancelPurge(jobId: string): Promise<void> {
    return this.setJobStatus(jobId, 'cancelled');
  }

  markPurgeRunning(jobId: string): Promise<void> {
    return this.setJobStatus(jobId, 'running');
  }

  /** Includes one that stopped part-way, so a re-run finishes it. */
  async duePurges(now: Date): Promise<string[]> {
    const jobs = await this.purgeJobs();
    const unfinished = ['pending', 'running'];
    return [...new Set(jobs.map((j) => j.slug))].filter((slug) => {
      const latest = jobs.find((j) => j.slug === slug)!;
      return unfinished.includes(latest.status) && new Date(latest.purgeAfter) <= now;
    });
  }

  /** What stays after a purge says nothing about who it was (LLD-10 §8). */
  /** Not a suspended company's: its containers are stopped, so it waits until it's resumed. */
  async deletionsDue(): Promise<{ slug: string; requestId: string }[]> {
    return this.db
      .select({ slug: schema.tenants.slug, requestId: schema.privacyRequests.id })
      .from(schema.privacyRequests)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.privacyRequests.tenantId))
      .where(
        and(
          eq(schema.privacyRequests.type, 'delete'),
          eq(schema.privacyRequests.status, 'approved'),
          eq(schema.tenants.status, 'active'),
        ),
      );
  }

  async deletionSubject(
    slug: string,
    requestId: string,
  ): Promise<{ tenantId: string; userId: string; email: string; keycloakId: string } | null> {
    const [row] = await this.db
      .select({
        tenantId: schema.users.tenantId,
        userId: schema.users.id,
        email: schema.users.email,
        keycloakId: schema.users.keycloakId,
      })
      .from(schema.privacyRequests)
      .innerJoin(schema.tenants, eq(schema.tenants.id, schema.privacyRequests.tenantId))
      .innerJoin(schema.users, eq(schema.users.id, schema.privacyRequests.userId))
      .where(
        and(
          eq(schema.tenants.slug, slug),
          eq(schema.privacyRequests.id, requestId),
          eq(schema.privacyRequests.type, 'delete'),
          eq(schema.privacyRequests.status, 'approved'),
        ),
      );
    return row ?? null;
  }

  /**
   * As in anonymiseTenant, for one person. Their usage rows keep the id, so the company's
   * totals still add up, but nothing is left to say who that was.
   */
  async forgetUser(
    tenantId: string,
    userId: string,
    requestId: string,
    slug: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        update users set
          email = 'deleted-' || id::text || '@deleted.invalid',
          name = 'Deleted user',
          keycloak_id = 'deleted-' || id::text,
          status = 'deleted'
        where id = ${userId} and tenant_id = ${tenantId}`);
      await tx.execute(
        sql`update requests set payload = '{}'::jsonb
            where user_id = ${userId} and tenant_id = ${tenantId}`,
      );
      await tx.execute(
        sql`update privacy_requests set file_url = null
            where user_id = ${userId} and tenant_id = ${tenantId}`,
      );
      await tx.execute(sql`
        update gateway_keys set revoked_at = now()
        where user_id = ${userId} and tenant_id = ${tenantId} and revoked_at is null`);
      await tx.execute(sql`
        update privacy_requests set status = 'completed', completed_at = now()
        where id = ${requestId} and tenant_id = ${tenantId}`);
      await tx.insert(schema.auditLog).values({
        id: randomUUID(),
        tenantId,
        actorType: 'system',
        actorId: 'provisioner',
        action: 'privacy.delete_done',
        targetType: 'user',
        targetId: userId,
        details: { slug, requestId },
      });
    });
  }

  async enforceRetention(): Promise<{ usage: number; usageDaily: number; audit: number }> {
    const rows = await this.db.execute(sql`select * from enforce_retention()`);
    const row = rows[0] as Record<string, unknown>;
    return {
      usage: Number(row['expired_usage']),
      usageDaily: Number(row['expired_usage_daily']),
      audit: Number(row['expired_audit']),
    };
  }

  /** False if that date already has a rate: an invoice may rely on it, so it stays. */
  async saveFxRate(rate: FxRate): Promise<boolean> {
    const added = await this.db
      .insert(schema.fxRates)
      .values({
        rateDate: rate.date,
        currency: rate.currency,
        buying: rate.buying,
        selling: rate.selling,
      })
      .onConflictDoNothing()
      .returning({ date: schema.fxRates.rateDate });
    return added.length > 0;
  }

  async recordDailyRun(details: Record<string, unknown>): Promise<void> {
    await this.db.insert(schema.auditLog).values({
      id: randomUUID(),
      tenantId: null,
      actorType: 'system',
      actorId: 'provisioner',
      action: 'platform.daily',
      targetType: 'platform',
      targetId: null,
      details,
    });
  }

  async anonymiseTenant(tenantId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`
        update users set
          email = 'deleted-' || id::text || '@deleted.invalid',
          name = 'Deleted user',
          keycloak_id = 'deleted-' || id::text,
          status = 'disabled'
        where tenant_id = ${tenantId}`);
      await tx.execute(
        sql`update requests set payload = '{}'::jsonb where tenant_id = ${tenantId}`,
      );
      await tx.execute(
        sql`update privacy_requests set file_url = null where tenant_id = ${tenantId}`,
      );
      await tx.execute(sql`
        update gateway_keys set revoked_at = now()
        where tenant_id = ${tenantId} and revoked_at is null`);
    });
  }

  async startJob(slug: string, type: string): Promise<string> {
    const [job] = await this.db
      .insert(schema.jobs)
      .values({ type, status: 'running', payload: { slug } })
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

  async finishJob(jobId: string, result: Record<string, unknown>): Promise<void> {
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
