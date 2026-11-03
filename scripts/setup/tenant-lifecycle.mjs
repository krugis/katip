// SPDX-License-Identifier: AGPL-3.0-only
// The Docker side of suspend, resume, delete, purge and upgrade (LLD-07 §2a, §4). The data
// side runs in the provisioner's container, which has no Docker socket.
import {
  removeTenantFromHost,
  renderTenantFiles,
  runProvisionerWith,
  runTenantAction,
  smokeTenant,
  startTenant,
  tenantCompose,
  tenantProject,
  tenantProjectCompose,
  tenantStatuses,
} from './steps.mjs';
import { ensureTenantSecrets } from './tenants.mjs';
import { run } from './util.mjs';

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

/** Removes one person from a company's search index, and waits until it has really gone. */
async function forgetInSearch(ctx, slug, lcUserId) {
  const container = `${tenantProject(ctx.config, { slug })}-meili-${slug}-1`;
  const meili = async (method, path, body) => {
    const data = body ? `-d '${JSON.stringify(body)}'` : '';
    const { code, out } = await run('docker', [
      'exec',
      container,
      'sh',
      '-c',
      `curl -s -X ${method} -H "Authorization: Bearer $MEILI_MASTER_KEY" -H 'content-type: application/json' ${data} http://localhost:7700${path}`,
    ]);
    if (code !== 0) throw new Error(`the search index of ${slug} did not answer`);
    return JSON.parse(out);
  };
  for (const index of ['messages', 'convos']) {
    const task = await meili('POST', `/indexes/${index}/documents/delete`, {
      filter: `user = "${lcUserId}"`,
    });
    if (task.code === 'index_not_found') continue;
    if (task.taskUid === undefined) throw new Error(`search index ${index}: ${task.code}`);
    let status = 'enqueued';
    for (let i = 0; i < 60 && ['enqueued', 'processing'].includes(status); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      ({ status } = await meili('GET', `/tasks/${task.taskUid}`));
    }
    if (status !== 'succeeded') throw new Error(`search index ${index}: task ${status}`);
  }
}

/**
 * Carries out the deletions that companies' admins have approved. The search index and files
 * come first, as the database step removes what says whose they are. One failing doesn't
 * stop the rest, and a re-run finishes it.
 */
export async function forgetDue(ctx) {
  const { deletions } = await runTenantAction(ctx, 'deletions-due', 'none');
  let done = 0;
  const failed = [];
  for (const { slug, requestId } of deletions) {
    try {
      const { lcUserId } = await runProvisionerWith(ctx, 'deletion-lookup', { slug, requestId });
      if (lcUserId) {
        if (!/^[0-9a-f]{24}$/.test(lcUserId)) throw new Error('unexpected LibreChat id');
        await forgetInSearch(ctx, slug, lcUserId);
        const { code } = await run('docker', [
          'exec',
          `${tenantProject(ctx.config, { slug })}-lc-${slug}-1`,
          'rm',
          '-rf',
          `/app/uploads/${lcUserId}`,
          `/app/uploads/temp/${lcUserId}`,
          `/app/client/public/images/${lcUserId}`,
        ]);
        if (code !== 0) throw new Error('could not remove their uploaded files');
      }
      await runProvisionerWith(ctx, 'deletion-finish', { slug, requestId });
      done += 1;
    } catch (e) {
      failed.push(`${slug} ${requestId}: ${e.message.trim().split('\n').at(-1)}`);
    }
  }
  return { done, failed };
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
