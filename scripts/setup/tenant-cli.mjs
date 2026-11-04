#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm tenant:create  --slug acme --name "ACME A.Ş." --plan business --seats 10 --admin-email it@acme.com.tr [--region eu] [--kvkk]
 * pnpm tenant:suspend --slug acme
 * pnpm tenant:resume  --slug acme                # also restores a deleted tenant
 * pnpm tenant:delete  --slug acme --confirm acme # locks it out; the purge comes 30 days later
 * pnpm tenant:purge-due                          # runs the purges whose wait is over
 * pnpm tenant:forget-due                         # carries out the deletions admins approved
 * pnpm tenant:daily                              # all of the above that's due, retention and old chats
 * pnpm tenant:upgrade --slug acme | --all        # rolls out the image and settings in the config
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { AUTO_KEYS, createAndStartTenant, deriveEnv, loadAllTenantSecrets } from './steps.mjs';
import {
  daily,
  forgetDue,
  purgeDue,
  resume,
  softDelete,
  suspend,
  upgrade,
} from './tenant-lifecycle.mjs';
import { adoptTenantSecretsFromEnvFile } from './tenants.mjs';
import { ensureEnvFile, INFRA } from './util.mjs';

const USAGE =
  'usage: pnpm tenant:create --slug <slug> --name <name> --plan <plan> --seats <n> --admin-email <email> [--region eu|tr] [--kvkk]';

const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');

const options = () =>
  parseArgs({
    args: rest,
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      plan: { type: 'string' },
      seats: { type: 'string' },
      'admin-email': { type: 'string' },
      region: { type: 'string', default: 'eu' },
      kvkk: { type: 'boolean', default: false },
      confirm: { type: 'string' },
      all: { type: 'boolean', default: false },
    },
  }).values;

function createArguments(values) {
  const missing = ['slug', 'name', 'plan', 'seats', 'admin-email'].filter((k) => !values[k]);
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}\n${USAGE}`);
  const seats = Number(values.seats);
  if (!Number.isInteger(seats) || seats < 1) throw new Error('--seats must be a positive integer');
  return {
    slug: values.slug,
    name: values.name,
    plan: values.plan,
    seats,
    admin_email: values['admin-email'],
    region: values.region,
    kvkk_addon: values.kvkk,
  };
}

const requireSlug = (values) => {
  if (!values.slug) throw new Error(`missing: --slug`);
  return values.slug;
};

async function create(ctx, values) {
  const tenant = createArguments(values);
  const started = Date.now();
  const result = await createAndStartTenant(ctx, tenant);
  const url = `https://${tenant.slug}.${ctx.config.project.base_domain}`;
  if (result.alreadyExists) {
    console.log(`Tenant ${tenant.slug} already exists, and is running at ${url}. Nothing changed.`);
    return;
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`Tenant ${tenant.slug} is running at ${url} (${seconds} s).`);
  console.log(`Steps: ${result.changedSteps.join(', ')}.`);
  if (result.changedSteps.includes('tenant-admin')) {
    console.log('The tenant admin has been invited by email.');
  }
}

const COMMANDS = {
  create,
  async suspend(ctx, values) {
    const slug = requireSlug(values);
    const changed = await suspend(ctx, slug);
    console.log(
      changed
        ? `Tenant ${slug} is suspended. The gateway refuses it within a minute. Its data is kept.`
        : `Tenant ${slug} was already suspended.`,
    );
  },
  async resume(ctx, values) {
    const slug = requireSlug(values);
    const changed = await resume(ctx, slug);
    console.log(
      changed ? `Tenant ${slug} is active and running.` : `Tenant ${slug} was already active.`,
    );
  },
  async delete(ctx, values) {
    const slug = requireSlug(values);
    if (values.confirm !== slug) {
      throw new Error(`to delete this tenant, add --confirm ${slug}`);
    }
    const { changed, purgeAfter } = await softDelete(ctx, slug);
    console.log(
      changed
        ? `Tenant ${slug} is locked out. Its data will be purged after ${purgeAfter}.\nUntil then, pnpm tenant:resume --slug ${slug} restores it.`
        : `Tenant ${slug} was already deleted. Its purge is due after ${purgeAfter}.`,
    );
  },
  async 'purge-due'(ctx) {
    const { purged, failed } = await purgeDue(ctx);
    console.log(purged.length > 0 ? `Purged: ${purged.join(', ')}.` : 'Nothing was purged.');
    if (failed.length > 0) {
      throw new Error(`Failed, so run this again:\n  ${failed.join('\n  ')}`);
    }
  },
  async 'forget-due'(ctx) {
    const { done, failed } = await forgetDue(ctx);
    console.log(`People deleted: ${done}.`);
    if (failed.length > 0) {
      throw new Error(`Failed, so run this again:\n  ${failed.join('\n  ')}`);
    }
  },
  async daily(ctx) {
    const { deleted, purged, expired, chats, fxDate, failed } = await daily(ctx);
    console.log(
      `${new Date().toISOString()} People deleted: ${deleted}. Purged: ${purged.join(', ') || 'none'}. Expired usage rows: ${expired.usage}, audit entries: ${expired.audit}. Old chats: ${chats.conversations}, with ${chats.messages} messages and ${chats.files} files (${chats.filesKept} files kept). Companies with more chats waiting: ${chats.backlog.length}. Companies waiting on a chat notice: ${chats.waiting}, already told: ${chats.notified}. Exchange rate date: ${fxDate ?? 'none'}.`,
    );
    if (failed.length > 0) throw new Error(`Failed:\n  ${failed.join('\n  ')}`);
  },
  async upgrade(ctx, values) {
    if (!values.all && !values.slug) throw new Error('add --slug <slug> or --all');
    const done = await upgrade(ctx, values.all ? null : [values.slug]);
    console.log(`Upgraded: ${done.join(', ') || 'none'}.`);
  },
};

try {
  const run = COMMANDS[command];
  if (!run) throw new Error(`unknown command: ${command}\n${USAGE}`);
  const values = options();
  const config = loadConfig();
  adoptTenantSecretsFromEnvFile(INFRA);
  const ctx = {
    config,
    infra: INFRA,
    env: ensureEnvFile(AUTO_KEYS, deriveEnv).env,
    log: () => {},
  };
  loadAllTenantSecrets(ctx);
  await run(ctx, values);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
