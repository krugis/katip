// SPDX-License-Identifier: AGPL-3.0-only
// The Docker side of suspend, resume, delete, purge and upgrade (LLD-07 §2a, §4). The data
// side runs in the provisioner's container, which has no Docker socket.
import {
  removeTenantFromHost,
  renderTenantFiles,
  runTenantAction,
  smokeTenant,
  startTenant,
  tenantCompose,
  tenantProjectCompose,
  tenantStatuses,
} from './steps.mjs';
import { ensureTenantSecrets } from './tenants.mjs';

const loadSecrets = (ctx, slug) => Object.assign(ctx.env, ensureTenantSecrets(ctx.infra, slug));

/** Locks a tenant out. Its data stays, and the gateway refuses it within a minute. */
export async function suspend(ctx, slug) {
  const { changed } = await runTenantAction(ctx, 'suspend', slug);
  await tenantProjectCompose(ctx, slug, ['stop']);
  return changed;
}

/** Lifts a suspension, or restores a deleted tenant that hasn't been purged. */
export async function resume(ctx, slug) {
  const { changed } = await runTenantAction(ctx, 'resume', slug);
  loadSecrets(ctx, slug);
  await startTenant(ctx, { slug });
  await smokeTenant(ctx, { slug });
  return changed;
}

/** Soft delete: locks the tenant out, and schedules the purge. Nothing is destroyed yet. */
export async function softDelete(ctx, slug) {
  if (ctx.config.tenants.some((t) => t.slug === slug)) {
    throw new Error(`tenant ${slug} is listed in katip.config.yaml: remove it there first`);
  }
  const result = await runTenantAction(ctx, 'delete', slug);
  await tenantProjectCompose(ctx, slug, ['stop']);
  return result;
}

/**
 * Purges every deleted tenant whose wait is over. One failing doesn't stop the rest, and a
 * re-run finishes it. Returns what was purged and what failed.
 */
export async function purgeDue(ctx) {
  const { slugs } = await runTenantAction(ctx, 'purges-due', 'none');
  const purged = [];
  const failed = [];
  for (const slug of slugs) {
    try {
      await runTenantAction(ctx, 'purge-start', slug);
      await tenantProjectCompose(ctx, slug, ['down', '-v', '--remove-orphans']);
      await runTenantAction(ctx, 'purge-finish', slug);
      await removeTenantFromHost(ctx, { slug });
      purged.push(slug);
    } catch (e) {
      failed.push(`${slug}: ${e.message.trim().split('\n').at(-1)}`);
    }
  }
  return { purged, failed };
}

/**
 * Rolls the tenants onto the image and settings in the config, one at a time, and stops at
 * the first that fails its health check, so a bad version can't reach the rest.
 */
export async function upgrade(ctx, slugs) {
  const statuses = await tenantStatuses(ctx);
  const targets = slugs ?? Object.keys(statuses).filter((s) => statuses[s] === 'active');
  for (const slug of targets) {
    if (statuses[slug] !== 'active') throw new Error(`tenant ${slug} is not active`);
  }
  const done = [];
  for (const slug of targets) {
    const t = { slug };
    try {
      loadSecrets(ctx, slug);
      renderTenantFiles(ctx, t);
      await tenantCompose(['pull'], ctx, t);
      await startTenant(ctx, t, { recreate: true });
      await smokeTenant(ctx, t);
      done.push(slug);
    } catch (e) {
      const rest = targets.slice(done.length + 1);
      throw new Error(
        `${slug} failed its upgrade, so the rest were not touched.\n` +
          `  Done: ${done.join(', ') || 'none'}\n  Not started: ${rest.join(', ') || 'none'}\n  ${e.message.trim().split('\n').at(-1)}`,
      );
    }
  }
  return done;
}
