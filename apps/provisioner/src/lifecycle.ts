// SPDX-License-Identifier: AGPL-3.0-only
// suspend, resume, delete and purge (LLD-07 §2a, tracker P1-23). The Docker work stays with
// the host-side script. Deleting only locks a tenant out: its chats and files go when the
// purge job runs, after a wait in which it can still be restored.
import type { IdentityAdmin } from './provision.js';
import type { ProvisionerStore } from './store.js';

export const PURGE_WAIT_DAYS = 30;

export interface LifecycleDeps {
  store: ProvisionerStore;
  identity: Pick<IdentityAdmin, 'purgeTenantIdentity'>;
  dropMongoDatabase: (database: string) => Promise<void>;
}

export interface LifecycleResult {
  changed: boolean;
  /** delete: when the purge is due. */
  purgeAfter?: string;
}

async function existing(store: ProvisionerStore, slug: string) {
  const state = await store.tenantState(slug);
  if (!state) throw new Error(`tenant ${slug} does not exist`);
  return state;
}

export async function suspendTenant(deps: LifecycleDeps, slug: string): Promise<LifecycleResult> {
  const { store } = deps;
  const { id, status } = await existing(store, slug);
  if (status === 'deleted') throw new Error(`tenant ${slug} has been deleted`);
  if (status === 'suspended') return { changed: false };
  await store.setTenantStatus(id, 'suspended');
  await store.auditAction(id, 'tenant.suspend', slug);
  return { changed: true };
}

/** Lifts a suspension, or restores a deleted tenant for as long as it hasn't been purged. */
export async function resumeTenant(deps: LifecycleDeps, slug: string): Promise<LifecycleResult> {
  const { store } = deps;
  const { id, status } = await existing(store, slug);
  if (status === 'active') return { changed: false };
  if (status === 'deleted') {
    const purge = await store.latestPurge(slug);
    if (!purge || purge.status === 'running' || purge.status === 'done') {
      throw new Error(`tenant ${slug} has been purged, and can't be restored`);
    }
    await store.cancelPurge(purge.jobId);
  }
  await store.setTenantStatus(id, 'active');
  await store.auditAction(id, status === 'deleted' ? 'tenant.restore' : 'tenant.resume', slug);
  return { changed: true };
}

export async function deleteTenant(
  deps: LifecycleDeps,
  slug: string,
  now: Date = new Date(),
): Promise<LifecycleResult> {
  const { store } = deps;
  const { id, status } = await existing(store, slug);
  const scheduled = await store.latestPurge(slug);
  if (status === 'deleted' && scheduled) {
    return { changed: false, purgeAfter: scheduled.purgeAfter };
  }
  const purgeAfter = new Date(now.getTime() + PURGE_WAIT_DAYS * 86_400_000).toISOString();
  await store.schedulePurge(id, slug, purgeAfter);
  await store.setTenantStatus(id, 'deleted');
  await store.auditAction(id, 'tenant.delete', slug, { purgeAfter });
  return { changed: true, purgeAfter };
}

export const purgesDue = (deps: LifecycleDeps, now: Date = new Date()): Promise<string[]> =>
  deps.store.duePurges(now);

/** From here the tenant can't be restored, so the host may destroy its containers and files. */
export async function startPurge(
  deps: LifecycleDeps,
  slug: string,
  now: Date = new Date(),
): Promise<void> {
  const { store } = deps;
  const { status } = await existing(store, slug);
  const purge = await store.latestPurge(slug);
  const due = purge && new Date(purge.purgeAfter) <= now;
  if (status !== 'deleted' || !purge || !due || purge.status === 'done') {
    throw new Error(`tenant ${slug} is not due for purge`);
  }
  await store.markPurgeRunning(purge.jobId);
}

/**
 * Destroys the tenant's chats and logins, and anonymises what has to stay. Usage, invoices
 * and the audit log remain for their retention periods (LLD-10 §8). The tenant's row stays
 * too, so its slug can never be reused. Safe to repeat if it stops part-way.
 */
export async function finishPurge(deps: LifecycleDeps, slug: string): Promise<void> {
  const { store } = deps;
  const { id } = await existing(store, slug);
  const purge = await store.latestPurge(slug);
  if (purge?.status !== 'running') throw new Error(`tenant ${slug} has no purge in progress`);
  await deps.dropMongoDatabase(`lc_${slug}`);
  await deps.identity.purgeTenantIdentity(slug);
  await store.anonymiseTenant(id);
  await store.finishJob(purge.jobId, { purgeAfter: purge.purgeAfter, purged: true });
  await store.auditAction(id, 'tenant.purge', slug);
}
