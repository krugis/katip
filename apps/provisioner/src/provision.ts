// SPDX-License-Identifier: AGPL-3.0-only
// tenant:create (LLD-07 §2, tracker P1-21, P1-22), in stages, with the host starting
// LibreChat between them. Each step checks what exists and adds what's missing, so a re-run
// finishes a failed attempt, and changes nothing once it's complete.
import { z } from 'zod';
import { hashGatewayKey, keyPrefix, verifyKey } from '@katip/shared';
import type { ProvisionerStore } from './store.js';

/** Hostnames the platform itself uses: a tenant called this would take over its route. */
export const RESERVED_SLUGS = ['auth', 'console', 'mailpit', 'provider', 'www', 'api', 'admin'];

export const TenantInputSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]{3,32}$/, 'must match ^[a-z0-9-]{3,32}$')
    .refine((s) => !RESERVED_SLUGS.includes(s), 'is reserved for the platform'),
  name: z.string().min(1),
  planCode: z.string().min(1),
  seats: z.number().int().positive(),
  region: z.enum(['eu', 'tr']).default('eu'),
  kvkkAddon: z.boolean().default(false),
  adminEmail: z.string().email(),
  baseDomain: z.string().min(1),
});
export type TenantInput = z.infer<typeof TenantInputSchema>;

export interface TenantSecrets {
  gatewayKey: string;
  oidcClientSecret: string;
  mongoPassword: string;
}

/** Keycloak, as this needs it. */
export interface IdentityAdmin {
  /** Organization, LibreChat client and its `member` role. True if anything was added. */
  ensureTenantIdentity(input: TenantInput, oidcClientSecret: string): Promise<boolean>;
  /** The first tenant admin, in the organization, with their roles. */
  ensureAdmin(input: TenantInput): Promise<{ id: string }>;
  /** Emails the tenant admin a link to set their password and MFA. */
  sendInvite(userId: string, input: TenantInput): Promise<void>;
  /** Undoes a failed first attempt. Leaves anyone who has already logged in. */
  removeTenantIdentity(input: TenantInput): Promise<void>;
  /** The purge: organization, client, and members who belong nowhere else. */
  purgeTenantIdentity(slug: string): Promise<void>;
}

/** MongoDB, as this needs it. True if the login was created. */
export type EnsureMongoUser = (database: string, password: string) => Promise<boolean>;

export interface ProvisionDeps {
  store: ProvisionerStore;
  identity: IdentityAdmin;
  ensureMongoUser: EnsureMongoUser;
  dropMongoDatabase: (database: string) => Promise<void>;
}

export interface ProvisionResult {
  tenantId: string;
  /** Nothing had to be done. */
  alreadyExists: boolean;
  changedSteps: string[];
}

export class ProvisionError extends Error {
  constructor(
    public readonly step: string,
    cause: unknown,
  ) {
    super(`step ${step} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ProvisionError';
  }
}

/** Runs named steps as one job, which records the step that failed. */
async function asJob<T>(
  store: ProvisionerStore,
  slug: string,
  type: string,
  body: (step: <R>(name: string, fn: () => Promise<R>) => Promise<R>, jobId: string) => Promise<T>,
  result: (value: T) => Record<string, unknown>,
): Promise<T> {
  const jobId = await store.startJob(slug, type);
  let current = 'start';
  try {
    const value = await body(async (name, fn) => {
      current = name;
      await store.jobStep(jobId, name);
      return fn();
    }, jobId);
    await store.finishJob(jobId, result(value));
    return value;
  } catch (e) {
    // The step's name only: the message of a failed call may hold values.
    await store.failJob(jobId, current).catch(() => undefined);
    throw new ProvisionError(current, e);
  }
}

/**
 * The tenant has one live key of each type, and its secrets file holds it: replaces any other.
 * True if it changed anything.
 */
async function ensureKey(
  store: ProvisionerStore,
  tenantId: string,
  key: string,
  type: 'tenant' | 'service',
): Promise<boolean> {
  const prefix = keyPrefix(key);
  if (!prefix) throw new Error('the gateway key has the wrong format');
  for (const k of await store.liveGatewayKeys(tenantId, type)) {
    if (await verifyKey(key, k.keyHash)) return false;
  }
  await store.replaceGatewayKey(tenantId, hashGatewayKey(key), prefix, type);
  return true;
}

/**
 * The key a tenant's RAG API embeds with. It works for embeddings only (LLD-03 §1.3). Runs at
 * every start, so a tenant from before file search gets one, wherever it was made.
 */
export async function ensureRagKey(
  deps: Pick<ProvisionDeps, 'store'>,
  slug: string,
  key: string,
): Promise<{ changed: boolean }> {
  const id = await deps.store.tenantId(slug);
  if (!id) throw new Error('the tenant does not exist');
  return { changed: await ensureKey(deps.store, id, key, 'service') };
}

/** Everything a tenant's LibreChat needs before it can start. */
export async function createTenant(
  deps: ProvisionDeps,
  rawInput: unknown,
  secrets: TenantSecrets,
): Promise<ProvisionResult> {
  const input = TenantInputSchema.parse(rawInput);
  const { store } = deps;
  return asJob(
    store,
    input.slug,
    'tenant.create',
    async (step, jobId) => {
      const changedSteps: string[] = [];
      const db = await step('governance-db', () => store.ensureTenant(input));
      const id = db.tenantId;
      await store.jobTenant(jobId, id);
      if (db.created) changedSteps.push('governance-db');

      const identityChanged = await step('keycloak', () =>
        deps.identity.ensureTenantIdentity(input, secrets.oidcClientSecret),
      );
      if (identityChanged) changedSteps.push('keycloak');

      const mongoCreated = await step('mongodb', () =>
        deps.ensureMongoUser(`lc_${input.slug}`, secrets.mongoPassword),
      );
      if (mongoCreated) changedSteps.push('mongodb');

      await step('gateway-key', async () => {
        if (await ensureKey(store, id, secrets.gatewayKey, 'tenant')) {
          changedSteps.push('gateway-key');
        }
      });

      return { tenantId: id, alreadyExists: changedSteps.length === 0, changedSteps };
    },
    (r) => ({ steps: r.changedSteps }),
  );
}

/**
 * The last stage, once LibreChat is up and has passed its smoke test: only then is the
 * tenant admin invited, so nobody gets a link to something that isn't running.
 */
export async function finishTenant(
  deps: ProvisionDeps,
  rawInput: unknown,
  priorSteps: string[] = [],
): Promise<ProvisionResult> {
  const input = TenantInputSchema.parse(rawInput);
  const { store } = deps;
  return asJob(
    store,
    input.slug,
    'tenant.finish',
    async (step, jobId) => {
      const id = await store.tenantId(input.slug);
      if (!id) throw new Error('the tenant does not exist');
      await store.jobTenant(jobId, id);
      const changedSteps: string[] = [];

      // The DB row comes last: until it exists the invite hasn't gone out, so a re-run sends it.
      // Once it exists, a re-run adds no second admin, whatever email it's given.
      await step('tenant-admin', async () => {
        if (await store.hasTenantAdmin(id)) return;
        const admin = await deps.identity.ensureAdmin(input);
        await deps.identity.sendInvite(admin.id, input);
        await store.addTenantAdmin(id, admin.id, input);
        changedSteps.push('tenant-admin');
      });

      const all = [...priorSteps, ...changedSteps];
      if (all.length > 0) await store.audit(id, input.slug, all);
      return { tenantId: id, alreadyExists: all.length === 0, changedSteps };
    },
    (r) => ({ steps: r.changedSteps }),
  );
}

/**
 * Undoes a failed first attempt in Keycloak and Mongo, so it leaves nothing behind. A tenant
 * with users has been in use, so this refuses it, whatever the caller believes.
 */
export async function rollbackTenant(
  deps: ProvisionDeps,
  rawInput: unknown,
  failedStep: string,
): Promise<void> {
  const input = TenantInputSchema.parse(rawInput);
  const { store } = deps;
  await asJob(
    store,
    input.slug,
    'tenant.rollback',
    async (step) => {
      await step('check', async () => {
        if (await store.tenantHasUsers(input.slug)) {
          throw new Error('this tenant has users, so it will not be rolled back');
        }
      });
      await step('mongodb', () => deps.dropMongoDatabase(`lc_${input.slug}`));
      await step('keycloak', () => deps.identity.removeTenantIdentity(input));
    },
    () => ({ failedStep }),
  );
}
