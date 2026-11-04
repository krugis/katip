#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// pnpm test:backup: the real dump and restore commands against throwaway Postgres and Mongo
// containers of the pinned images, on a private network of their own (P1-71). It never touches
// the stack. It uses the repository's real migrations and row-level security, and fakes only
// the data. Needs a build first, for the roles' SQL in packages/db/dist.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  checkBackup,
  restoreGovernance,
  restoreMongo,
  takeBackup,
  tenantDatabases,
} from './backups.mjs';
import { loadConfig } from './config.mjs';
import { journalEntries, lastMigrationAt, migrationsToUndo } from './deploy-lib.mjs';
import { assessData, mongoshArgs, psqlArgs, readSnapshot } from './rollback-guard.mjs';
import { ROOT, run, runFromFile, runToFile } from './util.mjs';

const id = randomBytes(4).toString('hex');
const network = `backupcheck-${id}`;
const containers = { pg: `backupcheck-pg-${id}`, mongo: `backupcheck-mongo-${id}` };
const PG_PASSWORD = `pg-${randomBytes(12).toString('hex')}`;
const MONGO_PASSWORD = `mg-${randomBytes(12).toString('hex')}`;
const work = mkdtempSync(join(tmpdir(), 'backup-check-'));
const seen = [];
const docker = async (args) => {
  const r = await run('docker', args);
  seen.push(args.join(' '), r.out);
  return r;
};
const sys = {
  docker,
  dockerToFile: async (args, file) => {
    const r = await runToFile('docker', args, file);
    seen.push(args.join(' '), r.out);
    return r;
  },
  dockerFromFile: async (args, file) => {
    const r = await runFromFile('docker', args, file);
    seen.push(args.join(' '), r.out);
    return r;
  },
  now: () => new Date(),
};

let failures = 0;
function check(ok, what) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
}

const sql = async (text, database = 'governance') => {
  const r = await docker(psqlArgs(containers, text, database));
  if (r.code !== 0) throw new Error(`sql failed: ${text.slice(0, 80)}: ${r.out}`);
  return r.out.trim().split('\n').at(-1);
};
const mongo = async (code) => {
  const r = await docker(mongoshArgs(containers, code));
  if (r.code !== 0) throw new Error(`mongosh failed: ${r.out}`);
  return r.out.trim().split('\n').at(-1);
};
const pgFile = async (file) => {
  const r = await sys.dockerFromFile(
    [
      'exec',
      '-i',
      containers.pg,
      'sh',
      '-c',
      'psql -U "$POSTGRES_USER" -d governance -v ON_ERROR_STOP=1 -q',
    ],
    file,
  );
  if (r.code !== 0) throw new Error(`psql failed on ${file}: ${r.out.slice(-400)}`);
};

async function waitFor(what, fn) {
  for (let i = 0; i < 90; i += 1) {
    if (await fn().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${what} did not start`);
}

async function start(config) {
  await run('docker', ['network', 'create', '--internal', network]);
  const up = await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containers.pg,
      '--network',
      network,
      '-e',
      'POSTGRES_USER=katip',
      '-e',
      'POSTGRES_DB=governance',
      '-e',
      'POSTGRES_PASSWORD',
      config.images.postgres,
    ],
    { env: { POSTGRES_PASSWORD: PG_PASSWORD } },
  );
  if (up.code !== 0) throw new Error(up.out);
  const up2 = await run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      containers.mongo,
      '--network',
      network,
      '-e',
      'MONGO_INITDB_ROOT_USERNAME=katip',
      '-e',
      'MONGO_INITDB_ROOT_PASSWORD',
      config.images.mongodb,
    ],
    { env: { MONGO_INITDB_ROOT_PASSWORD: MONGO_PASSWORD } },
  );
  if (up2.code !== 0) throw new Error(up2.out);
  // The image's init also starts a temporary server, so ask for a real answer, twice over.
  await waitFor(
    'Postgres',
    async () =>
      (
        await run('docker', [
          'exec',
          containers.pg,
          'sh',
          '-c',
          'psql -h 127.0.0.1 -U "$POSTGRES_USER" -d governance -Atc "select 1"',
        ])
      ).code === 0,
  );
  await waitFor(
    'Mongo',
    async () =>
      (
        await run(
          'docker',
          mongoshArgs(containers, 'print(db.getSiblingDB("admin").runCommand({ ping: 1 }).ok)'),
        )
      ).code === 0,
  );
}

/** The real schema: every migration, and the same RLS and roles `migrate.ts` applies. */
async function migrateUpTo(entries) {
  await sql('CREATE EXTENSION IF NOT EXISTS vector');
  await sql('CREATE SCHEMA IF NOT EXISTS drizzle');
  await sql(
    'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  );
  for (const e of entries) {
    await pgFile(join(ROOT, 'packages', 'db', 'drizzle', `${e.tag}.sql`));
    await sql(
      `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('${e.tag}', ${e.when})`,
    );
  }
  const rls = await import(pathToFileURL(join(ROOT, 'packages', 'db', 'dist', 'rls.js')).href);
  const parts = [
    ...rls.TENANT_OWNED_TABLES.flatMap((t) => [
      `DROP POLICY IF EXISTS tenant_isolation ON ${t};`,
      rls.tenantRlsSql(t),
    ]),
    rls.PROVIDER_ROLE_SQL,
    rls.GATEWAY_ROLE_SQL,
    rls.USAGE_ROLLUP_SQL,
    rls.CONSOLE_ROLE_SQL,
  ];
  const file = join(work, 'rls.sql');
  writeFileSync(file, parts.join('\n'));
  await pgFile(file);
}

const ROW_CHECKS = `select (select count(*) from pg_policies) || '/' ||
  (select count(*) from information_schema.role_table_grants where grantee in ('katip_gateway', 'katip_console', 'katip_provider')) || '/' ||
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity)`;

async function main() {
  const config = loadConfig();
  const entries = journalEntries(ROOT);
  const [latest] = entries.slice(-1);
  await start(config);
  await migrateUpTo(entries);

  // The state a deploy would copy.
  await sql(`insert into tenants (slug, name) values ('acme', 'Acme Ltd.'), ('demo', 'Demo A.Ş.')`);
  await sql(`insert into users (tenant_id, keycloak_id, email, name, role, status)
    select id, 'kc-ayse', 'ayse@acme.com.tr', 'Ayşe', 'user', 'active' from tenants where slug = 'acme'`);
  await mongo(`
    const d = db.getSiblingDB('lc_acme');
    d.createUser({ user: 'lc_acme', pwd: 'tenant-login', roles: [{ role: 'readWrite', db: 'lc_acme' }] });
    const u = d.users.insertOne({ email: 'ayse@acme.com.tr' }).insertedId;
    d.conversations.insertMany([{ conversationId: 'c1', user: u.toHexString(), title: 'Özel' }, { conversationId: 'c2', user: u.toHexString() }]);
    db.getSiblingDB('lc_demo').users.insertOne({ email: 'user@demo.localhost' });
  `);
  const before = await sql(ROW_CHECKS);
  const migrationBefore = await lastMigrationAt(sys, containers);
  check(migrationBefore === latest.when, 'the migration table says which migration is newest');

  // The rollback's inventory, read for real.
  const snapshot = await readSnapshot(docker, 'backupcheck-nothing', containers, []);
  const acme = snapshot.mongo?.find((d) => d.db === 'lc_acme');
  check(snapshot.governance?.length === 2, 'the rollback reads the companies');
  check(
    acme?.chats === 2 && acme.users.length === 1,
    'the rollback reads LibreChat users and chats',
  );
  check(
    /^[0-9a-f]{24}$/.test(acme?.users[0]?.id ?? '') && acme.chatOwners[0] === acme.users[0].id,
    'chat owners match account ids',
  );
  const verdict = assessData({ ...snapshot, volumes: ['x_pgdata'] }, config);
  check(verdict.verdict === 'real', 'a real person in acme makes this real data');

  // The dump.
  const backupsDir = join(work, 'backups');
  const manifest = await takeBackup(sys, {
    backupsDir,
    name: 'one',
    containers,
    commit: 'abc',
    kind: 'before-deploy',
  });
  check(manifest.files.length === 3, 'one file for governance and one per company');
  check((statSync(join(backupsDir, 'one')).mode & 0o777) === 0o700, 'the directory is mode 700');
  check(
    (statSync(join(backupsDir, 'one', 'governance.dump')).mode & 0o777) === 0o600,
    'the files are mode 600',
  );
  check(
    manifest.files.every((f) => f.bytes > 0),
    'no dump is empty',
  );
  const counted = manifest.files.find((f) => f.database === 'lc_acme')?.documents;
  check(counted === 3, `the manifest counts documents (${counted})`);
  await checkBackup(sys, { backupsDir, name: 'one', containers });
  check(true, 'the backup checks out, including through pg_restore -l and mongorestore --dryRun');
  check(
    JSON.stringify(await tenantDatabases(sys, containers)) === '["lc_acme","lc_demo"]',
    'every company database is found',
  );

  // A newer version: a migration that adds a table and a column, and rows written since.
  const later = latest.when + 1000;
  await sql('CREATE TABLE added_since (id int primary key, tenant_id uuid)');
  await sql('ALTER TABLE tenants ADD COLUMN added_since text');
  await sql(
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('0099_added', ${later})`,
  );
  await sql(`insert into tenants (slug, name) values ('newco', 'Sonra Geldi')`);
  await mongo(`
    const d = db.getSiblingDB('lc_acme');
    d.conversations.insertOne({ conversationId: 'c3', user: 'x' });
    d.addedSince.insertOne({ a: 1 });
    db.getSiblingDB('lc_newco').users.insertOne({ email: 'x@newco.com' });
  `);
  const undo = migrationsToUndo(
    [...entries, { tag: '0099_added', when: later }],
    migrationBefore,
    await lastMigrationAt(sys, containers),
  );
  check(undo.tags.join() === '0099_added', 'the migration to undo is named');

  // A damaged dump must fail before anything is dropped.
  const broken = join(work, 'broken.dump');
  writeFileSync(broken, 'this is not a dump');
  let refused = false;
  try {
    await restoreGovernance(sys, containers, broken);
  } catch {
    refused = true;
  }
  check(refused, 'a damaged dump is refused');
  check((await sql('select count(*) from tenants')) === '3', 'and the live database is untouched');
  check(
    (await sql(
      "select count(*) from pg_database where datname like 'governance\\_%'",
      'postgres',
    )) === '0',
    'and no scratch database stays',
  );

  // The way back.
  const dir = join(backupsDir, 'one');
  await restoreGovernance(sys, containers, join(dir, 'governance.dump'));
  for (const f of manifest.files.filter((x) => x.database !== 'governance')) {
    await restoreMongo(sys, containers, f.database, join(dir, f.file));
  }
  check((await sql('select count(*) from tenants')) === '2', 'rows written since are gone');
  check(
    (await sql("select to_regclass('public.added_since') is null")) === 't',
    'the table the migration added is gone',
  );
  check(
    (await sql(
      "select count(*) from information_schema.columns where table_name = 'tenants' and column_name = 'added_since'",
    )) === '0',
    'the column it added is gone',
  );
  check(
    (await lastMigrationAt(sys, containers)) === migrationBefore,
    'the migration table is back, so the migration can run again',
  );
  check(
    (await sql(ROW_CHECKS)) === before,
    'row-level security policies and role grants are as they were',
  );
  check(
    (await sql("select count(*) from users where email = 'ayse@acme.com.tr'")) === '1',
    'the data is back',
  );
  // Row-level security really applies to the role after the swap: it must see nothing here.
  const asGateway = await docker([
    'exec',
    containers.pg,
    'psql',
    '-U',
    'katip_gateway',
    '-h',
    '/var/run/postgresql',
    '-d',
    'governance',
    '-Atc',
    'select count(*) from users',
  ]);
  check(
    asGateway.code === 0 && asGateway.out.trim() === '0',
    'the gateway role can connect and sees no rows without a tenant set',
  );
  // The migration re-applies cleanly: what --clean would have broken.
  await sql('CREATE TABLE added_since (id int primary key, tenant_id uuid)');
  check(true, 'the newer migration can run again on the restored database');
  await sql('DROP TABLE added_since');

  check(
    (await mongo("print(db.getSiblingDB('lc_acme').conversations.countDocuments())")) === '2',
    'chats written since are gone',
  );
  check(
    (await mongo(
      "print(db.getSiblingDB('lc_acme').getCollectionNames().includes('addedSince'))",
    )) === 'false',
    'a collection added since is gone',
  );
  check(
    (await mongo("print(db.getSiblingDB('lc_acme').getUsers().users.length)")) === '1',
    "the company's own Mongo login survives",
  );
  check(
    (await mongo("print(db.getSiblingDB('lc_newco').users.countDocuments())")) === '1',
    'a company made since is left alone, as documented',
  );

  // The company's login still works after the drop and restore.
  const login = await docker([
    'exec',
    containers.mongo,
    'mongosh',
    '--quiet',
    '-u',
    'lc_acme',
    '-p',
    'tenant-login',
    '--authenticationDatabase',
    'lc_acme',
    'lc_acme',
    '--eval',
    'print(db.users.countDocuments())',
  ]);
  check(login.code === 0 && login.out.trim().endsWith('1'), 'and it can log in and read');

  // A dump that can't run stops the deploy, and leaves nothing half-written.
  await run('docker', ['stop', containers.mongo]);
  let stopped = null;
  try {
    await takeBackup(sys, {
      backupsDir,
      name: 'two',
      containers,
      commit: 'abc',
      kind: 'before-deploy',
    });
  } catch (e) {
    stopped = e.message;
  }
  check(stopped !== null, 'a failed dump throws');
  check(!readdirSync(backupsDir).includes('two'), 'and removes the partial directory');

  // Nothing above may have shown a password, in an argument or a message.
  const everything =
    seen.join('\n') + (stopped ?? '') + readFileSync(join(dir, 'manifest.json'), 'utf8');
  check(
    !everything.includes(PG_PASSWORD) && !everything.includes(MONGO_PASSWORD),
    'no password in any command line or output',
  );
}

async function cleanUp() {
  for (const c of Object.values(containers)) await run('docker', ['rm', '-f', '-v', c]);
  await run('docker', ['network', 'rm', network]);
  rmSync(work, { recursive: true, force: true });
}

try {
  await main();
} catch (e) {
  console.error(`FAIL ${e.message}`);
  failures += 1;
} finally {
  await cleanUp();
}
console.log(failures === 0 ? 'backup check passed' : `backup check: ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
