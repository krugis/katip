#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:users: the Users API on the running dev stack, with a new tenant and a real
 * login (tracker P1-24). The tenant is purged afterwards, leaving one anonymised row.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig, tenantNetworkName } from './config.mjs';
import { AUTO_KEYS, deriveEnv, loadAllTenantSecrets, runOnEdge, tenantSecretOf } from './steps.mjs';
import { ensureEnvFile, INFRA, ROOT, run } from './util.mjs';

const slug = `e2e-${randomBytes(3).toString('hex')}`;
const config = loadConfig();
const project = config.project.name;
const ctx = { config, infra: INFRA, env: ensureEnvFile(AUTO_KEYS, deriveEnv).env, log: () => {} };

const cli = (...args) =>
  run('node', [join(ROOT, 'scripts/setup/tenant-cli.mjs'), ...args], { timeoutMs: 420_000 });
const sql = async (query) => {
  const r = await run('docker', [
    'exec',
    `${project}-postgres-1`,
    'psql',
    '-U',
    ctx.env.POSTGRES_USER,
    '-d',
    'governance',
    '-Atc',
    query,
  ]);
  if (r.code !== 0) throw new Error(`sql failed: ${r.out}`);
  return r.out.trim();
};
const mails = async (to) => {
  const r = await run('docker', [
    'exec',
    `${project}-mailpit-1`,
    'wget',
    '-qO-',
    `http://localhost:8025/api/v1/search?query=to:${to}`,
  ]);
  return JSON.parse(r.out).messages_count;
};

console.log(`Users API on tenant ${slug}`);
let created = false;
try {
  const made = await cli(
    'create',
    '--slug',
    slug,
    '--name',
    'E2E Users',
    '--plan',
    'business',
    '--seats',
    '3',
    '--admin-email',
    `it@${slug}.test`,
  );
  if (made.code !== 0) throw new Error(`tenant:create failed:\n${made.out.slice(-500)}`);
  created = true;
  loadAllTenantSecrets(ctx);
  const other = config.tenants[0];
  const inner = await runOnEdge(
    ctx,
    { slug },
    'users-e2e-inner.mjs',
    {
      TENANT_ID: await sql(`select id from tenants where slug = '${slug}'`),
      OTHER_TENANT_ID: await sql(`select id from tenants where slug = '${other.slug}'`),
      OTHER_EMAIL: other.admin_email,
      TENANT_KEY: tenantSecretOf(ctx, { slug }, 'GATEWAY_KEY'),
    },
    tenantNetworkName(config, { slug }),
    {
      realm: config.identity.realm,
      consoleOrigin: `https://console.${config.project.base_domain}`,
      tenant: { slug },
    },
  );
  console.log(inner.out.trim());

  const toAlice = await mails(`alice@${slug}.test`);
  if (toAlice !== 2) throw new Error(`FAILED: alice should have 2 invites, has ${toAlice}`);
  console.log('  ok  the invite and its resend reached the mailbox');
  const entries = await sql(
    `select count(*) from audit_log where target_id in (select id::text from users where email = 'alice@${slug}.test') and action like 'user.%'`,
  );
  if (Number(entries) < 5) throw new Error(`FAILED: only ${entries} audit entries for alice`);
  console.log('  ok  each change is in the audit log');
  const leaks = await sql(
    `select count(*) from audit_log where action like 'user.%' and details::text ilike '%${slug}%'`,
  );
  if (leaks !== '0') throw new Error('FAILED: an email address reached the audit log');
  console.log('  ok  no email address in it');
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  if (created) {
    await cli('delete', '--slug', slug, '--confirm', slug);
    await sql(
      `update jobs set payload = jsonb_set(payload, '{purgeAfter}', '"2000-01-01T00:00:00.000Z"') where type = 'tenant.purge' and status = 'pending' and payload->>'slug' = '${slug}'`,
    );
    const purged = await cli('purge-due');
    if (purged.code !== 0) console.error(`could not clean up ${slug}: ${purged.out.slice(-300)}`);
  }
}
