// SPDX-License-Identifier: AGPL-3.0-only
// tenant:create (LLD-07 §2, tracker P1-21). Each step checks what exists and adds what's
// missing, so a re-run finishes a failed attempt, and changes nothing once it's complete.
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
}

/** MongoDB, as this needs it. True if the login was created. */
export type EnsureMongoUser = (database: string, password: string) => Promise<boolean>;

export interface ProvisionDeps {
  store: ProvisionerStore;
  identity: IdentityAdmin;
  ensureMongoUser: EnsureMongoUser;
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

export async function createTenant(
  deps: ProvisionDeps,
  rawInput: unknown,
  secrets: TenantSecrets,
): Promise<ProvisionResult> {
  const input = TenantInputSchema.parse(rawInput);
  const { store } = deps;
  const jobId = await store.startJob(input.slug);
  const changedSteps: string[] = [];
  let step = 'governance-db';
  let tenantId: string | null = null;
  const run = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    step = name;
    await store.jobStep(jobId, name);
    return fn();
  };

  try {
    const db = await run('governance-db', () => store.ensureTenant(input));
    tenantId = db.tenantId;
    await store.jobTenant(jobId, tenantId);
    const id = tenantId;
    if (db.created) changedSteps.push('governance-db');

    const identityChanged = await run('keycloak', () =>
      deps.identity.ensureTenantIdentity(input, secrets.oidcClientSecret),
    );
    if (identityChanged) changedSteps.push('keycloak');

    // The DB row comes last: until it exists the invite hasn't gone out, so a re-run sends it.
    // Once it exists, a re-run adds no second admin, whatever email it's given.
    await run('tenant-admin', async () => {
      if (await store.hasTenantAdmin(id)) return;
      const admin = await deps.identity.ensureAdmin(input);
      await deps.identity.sendInvite(admin.id, input);
      await store.addTenantAdmin(id, admin.id, input);
      changedSteps.push('tenant-admin');
    });

    const mongoCreated = await run('mongodb', () =>
      deps.ensureMongoUser(`lc_${input.slug}`, secrets.mongoPassword),
    );
    if (mongoCreated) changedSteps.push('mongodb');

    await run('gateway-key', async () => {
      const prefix = keyPrefix(secrets.gatewayKey);
      if (!prefix) throw new Error('the gateway key has the wrong format');
      const live = await store.liveGatewayKeys(id);
      for (const k of live) {
        if (await verifyKey(secrets.gatewayKey, k.keyHash)) return;
      }
      // The tenant has one live key, and its secrets file holds it: replace any other.
      await store.replaceGatewayKey(id, hashGatewayKey(secrets.gatewayKey), prefix);
      changedSteps.push('gateway-key');
    });

    const alreadyExists = changedSteps.length === 0;
    if (!alreadyExists) await store.audit(id, input.slug, changedSteps);
    await store.finishJob(jobId, { steps: changedSteps });
    return { tenantId: id, alreadyExists, changedSteps };
  } catch (e) {
    // The step's name only: the message of a failed call may hold values.
    await store.failJob(jobId, step).catch(() => undefined);
    throw new ProvisionError(step, e);
  }
}
