#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm tenant:create --slug acme --name "ACME A.Ş." --plan business --seats 10 --admin-email it@acme.com.tr [--region eu] [--kvkk]
 *
 * Creates a tenant on the running stack and starts its LibreChat. If a first attempt fails,
 * everything it made is removed. Re-running on an existing tenant changes nothing.
 */
import process from 'node:process';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.mjs';
import { AUTO_KEYS, createAndStartTenant, deriveEnv, loadAllTenantSecrets } from './steps.mjs';
import { adoptTenantSecretsFromEnvFile } from './tenants.mjs';
import { ensureEnvFile, INFRA } from './util.mjs';

const USAGE =
  'usage: pnpm tenant:create --slug <slug> --name <name> --plan <plan> --seats <n> --admin-email <email> [--region eu|tr] [--kvkk]';

function arguments_() {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      plan: { type: 'string' },
      seats: { type: 'string' },
      'admin-email': { type: 'string' },
      region: { type: 'string', default: 'eu' },
      kvkk: { type: 'boolean', default: false },
    },
  });
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

try {
  const tenant = arguments_();
  const config = loadConfig();
  adoptTenantSecretsFromEnvFile(INFRA);
  const ctx = {
    config,
    infra: INFRA,
    env: ensureEnvFile(AUTO_KEYS, deriveEnv).env,
    log: () => {},
  };
  loadAllTenantSecrets(ctx);
  const started = Date.now();
  const result = await createAndStartTenant(ctx, tenant);
  const url = `https://${tenant.slug}.${config.project.base_domain}`;
  if (result.alreadyExists) {
    console.log(`Tenant ${tenant.slug} already exists, and is running at ${url}. Nothing changed.`);
  } else {
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`Tenant ${tenant.slug} is running at ${url} (${seconds} s).`);
    console.log(`Steps: ${result.changedSteps.join(', ')}.`);
    if (result.changedSteps.includes('tenant-admin')) {
      console.log('The tenant admin has been invited by email.');
    }
  }
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
