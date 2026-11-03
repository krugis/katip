#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:lifecycle: a real tenant through create, suspend, resume, upgrade, delete, restore
 * and purge, on the running dev stack (tracker P1-23). The purge's wait is shortened by
 * editing its job. Each run leaves one anonymised row, because a slug is never reused.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { AUTO_KEYS, curlEdge, deriveEnv, gatewayStatus, loadAllTenantSecrets } from './steps.mjs';
import { ensureEnvFile, INFRA, ROOT, run } from './util.mjs';
import { readFileSync } from 'node:fs';
import { dailyCommand, dailyLogPath } from './schedule.mjs';

const slug = `e2e-${randomBytes(3).toString('hex')}`;
const email = `it@${slug}.test`;
const config = loadConfig();
const project = config.project.name;
const base = config.project.base_domain;
const ctx = { config, infra: INFRA, env: ensureEnvFile(AUTO_KEYS, deriveEnv).env, log: () => {} };
loadAllTenantSecrets(ctx);

let checks = 0;
const ok = (what) => {
  checks += 1;
  console.log(`  ok  ${what}`);
};
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  ok(what);
};

let lastOutput = '';
const cli = async (...args) => {
  const r = await run('node', [join(ROOT, 'scripts/setup/tenant-cli.mjs'), ...args], {
    timeoutMs: 420_000,
  });
  lastOutput = r.out;
  return r;
};
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
const health = async () => (await curlEdge(ctx, `${slug}.${base}`, '/health')).trim();
const containers = async () =>
  (await run('docker', ['ps', '-q', '--filter', `name=${project}-${slug}-`])).out.trim();
const anyContainers = async () =>
  (await run('docker', ['ps', '-aq', '--filter', `name=${project}-${slug}-`])).out.trim();
const eventually = async (fn, what, limitMs = 75_000) => {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (await fn()) return ok(what);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`FAILED: ${what}`);
};
const asAdmin = () => ['-H', `x-user-email: ${email}`];
const mongoUsers = async () => {
  const r = await run('docker', [
    'exec',
    '-e',
    `S=lc_${slug}`,
    '-e',
    `U=${ctx.env.MONGO_USER}`,
    '-e',
    `P=${ctx.env.MONGO_PASSWORD}`,
    `${project}-mongodb-1`,
    'sh',
    '-c',
    'mongosh --quiet -u "$U" -p "$P" --authenticationDatabase admin --eval "const d=db.getSiblingDB(process.env.S); print(d.getUsers().users.length + d.getCollectionNames().length)"',
  ]);
  return Number(r.out.trim().split('\n').at(-1));
};
const keycloak = async () => {
  const script = `
    const b='http://keycloak:8080';
    const t=(await (await fetch(b+'/realms/${config.identity.realm}/protocol/openid-connect/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'client_credentials',client_id:'katip-provisioner',client_secret:process.env.SEC})})).json()).access_token;
    const g=async(p)=>(await fetch(b+'/admin/realms/${config.identity.realm}'+p,{headers:{authorization:'Bearer '+t}})).json();
    const o=(await g('/organizations?max=1000')).filter((x)=>x.alias==='${slug}').length;
    const c=(await g('/clients?clientId=lc-${slug}')).length;
    const u=(await g('/users?email=${encodeURIComponent(email)}&exact=true')).length;
    console.log(o+c+u);`;
  const r = await run('docker', [
    'run',
    '--rm',
    '--network',
    `${project}_backend`,
    '-e',
    `SEC=${ctx.env.KATIP_PROVISIONER_KC_SECRET}`,
    '--entrypoint',
    'node',
    'ghcr.io/krugis/provisioner:dev',
    '--input-type=module',
    '-e',
    script,
  ]);
  return Number(r.out.trim().split('\n').at(-1));
};
const hostFiles = () => {
  const dirs = ['env/tenants', 'compose/tenants', 'librechat/rendered', 'traefik/dynamic'];
  return dirs.flatMap((d) => {
    const dir = join(INFRA, d);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(slug)) : [];
  });
};
const refused = async (promise, what) => {
  const r = await promise;
  check(r.code !== 0, what);
};

console.log(`Lifecycle of tenant ${slug}`);
try {
  console.log('create');
  let r = await cli(
    'create',
    '--slug',
    slug,
    '--name',
    'E2E Ltd',
    '--plan',
    'business',
    '--seats',
    '2',
    '--admin-email',
    email,
  );
  check(r.code === 0, 'tenant:create succeeds');
  loadAllTenantSecrets(ctx);
  check((await health()) === '200', 'LibreChat is healthy');
  check((await gatewayStatus(ctx, { slug }, asAdmin())) === '200', 'the gateway serves the admin');

  console.log('suspend');
  await refused(cli('suspend'), 'a missing slug is refused');
  r = await cli('suspend', '--slug', slug);
  check(r.code === 0, 'tenant:suspend succeeds');
  check(!(await containers()), 'its containers are stopped');
  await eventually(
    async () => (await gatewayStatus(ctx, { slug }, asAdmin())) === '403',
    'the gateway refuses it',
  );
  check((await mongoUsers()) > 0, 'its chats are kept');
  await refused(
    cli(
      'create',
      '--slug',
      slug,
      '--name',
      'E2E Ltd',
      '--plan',
      'business',
      '--seats',
      '2',
      '--admin-email',
      email,
    ),
    'tenant:create refuses a suspended tenant',
  );

  console.log('resume');
  r = await cli('resume', '--slug', slug);
  check(r.code === 0, 'tenant:resume succeeds');
  check((await health()) === '200', 'LibreChat is healthy again');
  await eventually(
    async () => (await gatewayStatus(ctx, { slug }, asAdmin())) === '200',
    'the gateway serves it again',
  );

  console.log('upgrade');
  r = await cli('upgrade', '--slug', slug);
  check(r.code === 0, 'tenant:upgrade succeeds');
  check((await health()) === '200', 'LibreChat is healthy after it');

  console.log('delete and restore');
  await refused(cli('delete', '--slug', slug), 'delete without --confirm is refused');
  await refused(
    cli('delete', '--slug', slug, '--confirm', 'wrong'),
    'delete with the wrong --confirm is refused',
  );
  await refused(
    cli('delete', '--slug', config.tenants[0].slug, '--confirm', config.tenants[0].slug),
    'delete refuses a tenant listed in the config',
  );
  check((await health()) === '200', 'the refused deletes changed nothing');
  r = await cli('delete', '--slug', slug, '--confirm', slug);
  check(r.code === 0, 'tenant:delete succeeds');
  check(!(await containers()), 'its containers are stopped');
  await eventually(
    async () => (await gatewayStatus(ctx, { slug }, asAdmin())) === '403',
    'the gateway refuses it',
  );
  r = await cli('purge-due');
  check(
    r.code === 0 && (await mongoUsers()) > 0,
    'purge-due leaves it alone before the wait is over',
  );
  r = await cli('resume', '--slug', slug);
  check(r.code === 0, 'tenant:resume restores it');
  check((await health()) === '200', 'LibreChat is healthy after the restore');
  check((await mongoUsers()) > 0, 'its chats came back with it');

  console.log('delete and purge');
  r = await cli('delete', '--slug', slug, '--confirm', slug);
  check(r.code === 0, 'tenant:delete succeeds');
  await sql(
    `update jobs set payload = jsonb_set(payload, '{purgeAfter}', '"2000-01-01T00:00:00.000Z"') where type = 'tenant.purge' and status = 'pending' and payload->>'slug' = '${slug}'`,
  );
  r = await cli('purge-due');
  check(r.code === 0, 'tenant:purge-due succeeds once the wait is over');

  // Exactly what cron will run, with as little environment as cron gives it.
  const command = dailyCommand();
  r = await run('env', ['-i', `HOME=${process.env.HOME}`, 'sh', '-c', command], {
    timeoutMs: 300_000,
  });
  check(r.code === 0, `it runs in the bare environment cron gives it: ${r.out.slice(-200)}`);
  check(
    /People deleted: \d+\. Purged: .*Expired usage rows: \d+/.test(
      readFileSync(dailyLogPath(), 'utf8'),
    ),
    'and says what it did in its log',
  );
  check(
    (await sql(
      `select count(*) from audit_log where action = 'platform.daily' and ts > now() - interval '5 minutes'`,
    )) !== '0',
    'and records the run',
  );
  check(!(await anyContainers()), 'no containers are left');
  const volumes = (await run('docker', ['volume', 'ls', '-q'])).out;
  check(!volumes.includes(slug), 'no volumes are left');
  const networks = (await run('docker', ['network', 'ls', '--format', '{{.Name}}'])).out;
  check(!networks.includes(slug), 'no network is left');
  check(hostFiles().length === 0, 'no files or secrets are left');
  check((await mongoUsers()) === 0, 'its Mongo database and login are gone');
  check((await keycloak()) === 0, 'its Keycloak organization, client and users are gone');
  const id = await sql(`select id from tenants where slug = '${slug}'`);
  check(
    (await sql(`select status from tenants where id = '${id}'`)) === 'deleted',
    'its row stays, marked deleted',
  );
  check(
    (await sql(
      `select count(*) from users where tenant_id = '${id}' and email ilike '%${slug}%'`,
    )) === '0',
    'no user email is left',
  );
  check(
    (await sql(
      `select count(*) from gateway_keys where tenant_id = '${id}' and revoked_at is null`,
    )) === '0',
    'its gateway key is revoked',
  );
  check(
    Number(await sql(`select count(*) from audit_log where target_id = '${slug}'`)) >= 6,
    'its audit trail stays',
  );
  await refused(cli('resume', '--slug', slug), 'a purged tenant cannot be restored');
  await refused(
    cli(
      'create',
      '--slug',
      slug,
      '--name',
      'E2E Ltd',
      '--plan',
      'business',
      '--seats',
      '2',
      '--admin-email',
      email,
    ),
    'its slug cannot be reused',
  );
  check(hostFiles().length === 0, 'the refused create left no files');

  console.log('other tenants');
  for (const t of config.tenants) {
    check(
      (await curlEdge(ctx, `${t.slug}.${base}`, '/health')).trim() === '200',
      `${t.slug} is unaffected`,
    );
  }
  console.log(`\nAll ${checks} checks passed.`);
} catch (e) {
  console.error(`\n${e.message}`);
  console.error(`Last command said:\n${lastOutput.trim().split('\n').slice(-6).join('\n')}`);
  console.error(`Whatever exists of tenant ${slug} was left as it is, to look into.`);
  process.exitCode = 1;
}
