// SPDX-License-Identifier: AGPL-3.0-only
// The copy `pnpm dev:deploy` takes before it migrates anything, and putting it back (P1-71).
// It sits on the same disk as the data, so it's a way back from a bad deploy and nothing more:
// it isn't the off-site backup of P1-42. No password goes on a command line: the containers
// expand their own, as `mongoshEval` in apps/console/e2e/run.mjs does.
import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { mongoshArgs, psqlArgs } from './rollback-guard.mjs';

export const DEFAULT_KEEP_BACKUPS = 5;
export const NOT_OFFSITE =
  'This copy is on the same disk as the data. It is not the off-site backup of P1-42.';

export const containersOf = (config) => ({
  pg: `${config.project.name}-postgres-1`,
  mongo: `${config.project.name}-mongodb-1`,
});

const GOVERNANCE_FILE = 'governance.dump';
const mongoFile = (database) => `${database}.archive.gz`;
const MONGO_DB = /^lc_[a-z0-9-]+$/;
const MONGO_AUTH =
  '--username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin';

const lastLine = (s = '') => s.trim().split('\n').at(-1) ?? '';
const sha256File = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function must(promise, what) {
  const r = await promise;
  if (r.code !== 0) throw new Error(`${what}: ${lastLine(r.out ?? r.err)}`);
  return r;
}

/** A stamp that sorts by time. */
export const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');

/** Every company's Mongo database, as Mongo knows them: not only the ones in the config. */
export async function tenantDatabases(sys, containers) {
  const { out } = await must(
    sys.docker(
      mongoshArgs(
        containers,
        `print(JSON.stringify(db.adminCommand({ listDatabases: 1, nameOnly: true }).databases.map((d) => d.name).filter((n) => n.startsWith('lc_'))))`,
      ),
    ),
    'could not list the Mongo databases',
  );
  const names = JSON.parse(lastLine(out));
  for (const name of names) {
    if (!MONGO_DB.test(name)) throw new Error(`unexpected Mongo database name: ${name}`);
  }
  return names;
}

const documentCount = async (sys, containers, database) =>
  Number(
    lastLine(
      (
        await must(
          sys.docker(
            mongoshArgs(
              containers,
              `print(String(db.getSiblingDB('${database}').stats().objects))`,
            ),
          ),
          `could not count ${database}`,
        )
      ).out,
    ),
  );

/** Reads the dump back through pg_restore: empty or damaged shows up here, not at restore time. */
async function verifyGovernance(sys, containers, file) {
  if (statSync(file).size === 0) throw new Error('the governance dump is empty');
  const { out } = await must(
    sys.dockerFromFile(['exec', '-i', containers.pg, 'pg_restore', '-l'], file),
    'the governance dump cannot be read',
  );
  if (!/TABLE DATA public tenants /.test(out)) {
    throw new Error('the governance dump holds no tenants table');
  }
}

/** How many bytes a gzip file holds. A truncated or damaged one throws. */
async function gunzippedBytes(file) {
  let bytes = 0;
  await pipeline(createReadStream(file), createGunzip(), async (chunks) => {
    for await (const chunk of chunks) bytes += chunk.length;
  });
  return bytes;
}

/**
 * Reads the whole archive, and has mongorestore list what's in it. Its dry run doesn't read the
 * documents, and a real restore here would write to the live server, so `pnpm test:backup` is
 * what shows that the documents come back.
 */
async function verifyMongo(sys, containers, database, file) {
  const bytes = await gunzippedBytes(file).catch(() => 0);
  if (bytes === 0) throw new Error(`the dump of ${database} is empty or damaged`);
  const { out } = await must(
    sys.dockerFromFile(
      [
        'exec',
        '-i',
        '-e',
        `K_DB=${database}`,
        containers.mongo,
        'sh',
        '-c',
        `exec mongorestore -v ${MONGO_AUTH} --dryRun --archive --gzip --nsInclude "$K_DB.*"`,
      ],
      file,
    ),
    `the dump of ${database} cannot be read`,
  );
  if (!out.includes(`archive prelude ${database}.`)) {
    throw new Error(`the dump of ${database} holds nothing`);
  }
}

/**
 * Dumps the governance database and each company's Mongo database into its own directory, mode
 * 700, and checks each one. A failure removes the partial directory and throws, so the caller
 * stops before changing anything.
 */
export async function takeBackup(sys, { backupsDir, name, containers, commit, kind }) {
  const dir = join(backupsDir, name);
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  chmodSync(backupsDir, 0o700);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    const files = [];
    const governance = join(dir, GOVERNANCE_FILE);
    await must(
      sys.dockerToFile(
        ['exec', containers.pg, 'sh', '-c', 'exec pg_dump -U "$POSTGRES_USER" -Fc governance'],
        governance,
      ),
      'could not dump the governance database',
    );
    await verifyGovernance(sys, containers, governance);
    files.push({ file: GOVERNANCE_FILE, database: 'governance' });

    for (const database of await tenantDatabases(sys, containers)) {
      const documents = await documentCount(sys, containers, database);
      const file = join(dir, mongoFile(database));
      await must(
        sys.dockerToFile(
          [
            'exec',
            '-e',
            `K_DB=${database}`,
            containers.mongo,
            'sh',
            '-c',
            `exec mongodump ${MONGO_AUTH} --db "$K_DB" --archive --gzip`,
          ],
          file,
        ),
        `could not dump ${database}`,
      );
      await verifyMongo(sys, containers, database, file);
      files.push({ file: mongoFile(database), database, documents });
    }

    const manifest = {
      name,
      kind,
      commit,
      takenAt: sys.now().toISOString(),
      note: NOT_OFFSITE,
      files: files.map((f) => ({
        ...f,
        bytes: statSync(join(dir, f.file)).size,
        sha256: sha256File(join(dir, f.file)),
      })),
    };
    writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    return manifest;
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Checks a backup is all there and readable. Run before anything is dropped. */
export async function checkBackup(sys, { backupsDir, name, containers }) {
  const dir = join(backupsDir, name);
  if (!existsSync(join(dir, 'manifest.json'))) {
    throw new Error(`backup ${name} is not on this machine: it may have been pruned`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  for (const f of manifest.files) {
    const path = join(dir, f.file);
    if (!existsSync(path) || sha256File(path) !== f.sha256) {
      throw new Error(`backup ${name}: ${f.file} is missing or has changed`);
    }
    if (f.database === 'governance') await verifyGovernance(sys, containers, path);
    else await verifyMongo(sys, containers, f.database, path);
  }
  return manifest;
}

/**
 * Restores into a new database and swaps it in by name. `pg_restore --clean` over the live one
 * is wrong here: it leaves whatever the newer migrations added, and the next deploy's migration
 * then fails on tables that already exist. If the restore fails, the live database is untouched.
 */
export async function restoreGovernance(sys, containers, file) {
  const SCRATCH = 'governance_restore';
  const OLD = 'governance_before_restore';
  const sql = (text, what) => must(sys.docker(psqlArgs(containers, text, 'postgres')), what);
  await sql(`DROP DATABASE IF EXISTS ${SCRATCH}`, 'could not clear the scratch database');
  await sql(`DROP DATABASE IF EXISTS ${OLD}`, 'could not clear the previous database');
  await must(
    sys.docker([
      'exec',
      '-e',
      `K_DB=${SCRATCH}`,
      containers.pg,
      'sh',
      '-c',
      'createdb -U "$POSTGRES_USER" -O "$POSTGRES_USER" -T template0 "$K_DB"',
    ]),
    'could not create the scratch database',
  );
  try {
    await must(
      sys.dockerFromFile(
        [
          'exec',
          '-i',
          '-e',
          `K_DB=${SCRATCH}`,
          containers.pg,
          'sh',
          '-c',
          'exec pg_restore -U "$POSTGRES_USER" -d "$K_DB" --exit-on-error --single-transaction',
        ],
        file,
      ),
      'pg_restore failed, so the live database was not touched',
    );
    await must(
      sys.docker(psqlArgs(containers, 'select count(*) from tenants', SCRATCH)),
      'the restored database has no tenants table, so the live one was not touched',
    );
  } catch (e) {
    await sys.docker(psqlArgs(containers, `DROP DATABASE IF EXISTS ${SCRATCH}`, 'postgres'));
    throw e;
  }
  await sql(
    "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'governance' and pid <> pg_backend_pid()",
    'could not close the connections to the governance database',
  );
  await sql(`ALTER DATABASE governance RENAME TO ${OLD}`, 'could not move the live database aside');
  try {
    await sql(`ALTER DATABASE ${SCRATCH} RENAME TO governance`, 'could not swap in the restore');
  } catch (e) {
    await sys.docker(
      psqlArgs(containers, `ALTER DATABASE ${OLD} RENAME TO governance`, 'postgres'),
    );
    throw e;
  }
  await sql(`DROP DATABASE ${OLD}`, 'restored, but could not remove the replaced database');
}

/**
 * Empties the company's database and restores it. Dropping first matters: mongorestore's --drop
 * only touches collections in the archive. The company's login lives in `admin`, so it stays.
 */
export async function restoreMongo(sys, containers, database, file) {
  if (!MONGO_DB.test(database)) throw new Error(`unexpected Mongo database name: ${database}`);
  await must(
    sys.docker(mongoshArgs(containers, `db.getSiblingDB('${database}').dropDatabase()`)),
    `could not empty ${database}`,
  );
  await must(
    sys.dockerFromFile(
      [
        'exec',
        '-i',
        '-e',
        `K_DB=${database}`,
        containers.mongo,
        'sh',
        '-c',
        `exec mongorestore ${MONGO_AUTH} --archive --gzip --nsInclude "$K_DB.*"`,
      ],
      file,
    ),
    `mongorestore failed for ${database}`,
  );
}

/** Which backups to delete. Newest first by name; `protect` stays whatever its age. */
export function backupsToPrune(names, keep, protect = []) {
  const newest = [...names].sort().reverse();
  return newest.slice(keep).filter((n) => !protect.includes(n));
}

export function pruneBackups(backupsDir, keep, protect) {
  if (!existsSync(backupsDir)) return [];
  const pruned = backupsToPrune(readdirSync(backupsDir), keep, protect);
  for (const name of pruned) rmSync(join(backupsDir, name), { recursive: true, force: true });
  return pruned;
}
