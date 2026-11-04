// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm dev:deploy` and `pnpm dev:deploy-back` (P1-71). Everything that touches git or Docker comes
// in through `sys`, so the order of things and every refusal can be tested with fakes.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_KEEP_BACKUPS,
  NOT_OFFSITE,
  checkBackup,
  containersOf,
  pruneBackups,
  restoreGovernance,
  restoreMongo,
  stamp,
  takeBackup,
  tenantDatabases,
} from './backups.mjs';
import { psqlArgs } from './rollback-guard.mjs';

/** Through the --redo machinery of dev:up. `config` too, so changed templates get rendered. */
export const DEPLOY_UP_FLAGS = [
  '--redo=config,build,governance-db,aiplane,billing,tenant,smoke,monitoring,isolation',
];

/** Going back doesn't build or pull: the point is to run the images that were kept. */
export const BACK_UP_FLAGS = [
  '--redo=config,governance-db,aiplane,billing,tenant,smoke,monitoring,isolation',
  '--skip=build,images',
];

const REGISTRY = 'ghcr.io/krugis';
const JOURNAL = join('packages', 'db', 'drizzle', 'meta', '_journal.json');

export const short = (commit) => commit.slice(0, 12);

/** What `build` makes, under the names it gives them. */
export function selfBuiltImages(config) {
  return [
    `${REGISTRY}/litellm:${config.images.litellm.version}`,
    `${REGISTRY}/presidio-analyzer:${config.images.presidio_analyzer.version}`,
    `${REGISTRY}/policy-gateway:dev`,
    `${REGISTRY}/provisioner:dev`,
    `${REGISTRY}/console:dev`,
    `${REGISTRY}/console-api:dev`,
    `${REGISTRY}/mock-llm:dev`,
    `${REGISTRY}/billing-bridge:dev`,
  ];
}

export const savedRef = (ref, tag) => `${ref.slice(0, ref.lastIndexOf(':'))}:${tag}`;

export const pinsOf = (config) =>
  Object.fromEntries(Object.entries(config.images).filter(([, v]) => typeof v === 'string'));

export const keepBackups = (config) => config.deploy?.keep_backups ?? DEFAULT_KEEP_BACKUPS;

// deploys.json ---------------------------------------------------------------

const recordsFile = (stateDir) => join(stateDir, 'deploys.json');

export function loadDeploys(stateDir) {
  const file = recordsFile(stateDir);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).deploys : [];
}

function saveDeploys(stateDir, deploys) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(recordsFile(stateDir), `${JSON.stringify({ version: 1, deploys }, null, 2)}\n`);
}

const deployEntries = (deploys) => deploys.filter((d) => d.kind === 'deploy');

/**
 * The deploy we're on: the newest one nobody has gone back from. One that stopped at its backup
 * or its tagging changed nothing, so it isn't one.
 */
export const currentDeploy = (deploys) =>
  deployEntries(deploys)
    .filter((d) => !d.rolledBack && d.previous)
    .at(-1) ?? null;

/**
 * Which commit the running images were built from. Only a finished deploy says, and only while
 * its images are still the ones running: someone may have run `dev:up --redo=build` since.
 */
export function runningVersion(deploys, images) {
  const last = currentDeploy(deploys);
  if (last?.status !== 'ok') return null;
  const byRef = new Map(images.map((i) => [i.ref, i.id]));
  const same = last.builtImages.every((b) => byRef.get(b.ref) === b.id);
  return same ? last : null;
}

// migrations -----------------------------------------------------------------

export const journalEntries = (root) =>
  JSON.parse(readFileSync(join(root, JOURNAL), 'utf8')).entries.map((e) => ({
    tag: e.tag,
    when: e.when,
  }));

/**
 * The migrations in the database now that weren't there before the deploy. Drizzle records each
 * one's journal time, and only ever compares against the newest, so these two numbers are all
 * it takes. `unknown` when either couldn't be read, which callers treat as a difference.
 */
export function migrationsToUndo(entries, before, now) {
  if (before === null || before === undefined || now === null || now === undefined) {
    return { unknown: true, tags: [] };
  }
  const tags = entries.filter((e) => e.when > before && e.when <= now).map((e) => e.tag);
  // The database moved on, by a migration this checkout's journal doesn't list.
  return { unknown: now > before && tags.length === 0, tags };
}

/** The newest migration applied, or null. A missing table is 0: nothing has been applied. */
export async function lastMigrationAt(sys, containers) {
  const { code, out } = await sys.docker(
    psqlArgs(
      containers,
      "select case when to_regclass('drizzle.__drizzle_migrations') is null then 0 else (select coalesce(max(created_at), 0) from drizzle.__drizzle_migrations) end",
    ),
  );
  const value = Number((out ?? '').trim().split('\n').at(-1));
  return code === 0 && Number.isFinite(value) ? value : null;
}

// images ---------------------------------------------------------------------

/**
 * The image id behind each of our references: what the container runs, as `:dev` may already
 * point elsewhere, or the tag itself for an image with no container, like the provisioner's.
 */
export async function currentImages(sys, config) {
  const running = new Map();
  const ids = await sys.docker([
    'ps',
    '-q',
    '--filter',
    `label=com.docker.compose.project=${config.project.name}`,
  ]);
  const containerIds = ids.code === 0 ? ids.out.split(/\s+/).filter(Boolean) : [];
  if (containerIds.length > 0) {
    const inspected = await sys.docker([
      'inspect',
      '-f',
      '{{.Config.Image}} {{.Image}}',
      ...containerIds,
    ]);
    if (inspected.code !== 0) throw new Error('could not read which images are running');
    for (const line of inspected.out.split('\n')) {
      const [ref, id] = line.trim().split(' ');
      if (ref?.startsWith(`${REGISTRY}/`)) running.set(ref, id);
    }
  }
  const refs = [...new Set([...selfBuiltImages(config), ...running.keys()])];
  const images = [];
  for (const ref of refs) {
    let id = running.get(ref);
    if (!id) {
      const r = await sys.docker(['image', 'inspect', '-f', '{{.Id}}', ref]);
      if (r.code === 0) id = r.out.trim();
    }
    if (id) images.push({ ref, id });
  }
  return images;
}

/** Tags every image, so a rebuild can't take it away. Stops at the first failure. */
async function tagImages(sys, images, tag) {
  const saved = [];
  for (const { ref, id } of images) {
    const savedAs = savedRef(ref, tag);
    const r = await sys.docker(['tag', id, savedAs]);
    if (r.code !== 0) throw new Error(`could not tag ${ref}: ${r.out.trim()}`);
    saved.push({ ref, id, savedAs });
  }
  return saved;
}

/** Image tags only the deploys past the newest `keep` use. Pure. */
export function imageTagsToPrune(deploys, keep) {
  const entries = deployEntries(deploys);
  const kept = new Set(
    entries.slice(-keep).flatMap((d) => d.previous?.images?.map((i) => i.savedAs) ?? []),
  );
  const old = entries
    .slice(0, -keep)
    .flatMap((d) => d.previous?.images?.map((i) => i.savedAs) ?? []);
  return [...new Set(old)].filter((tag) => !kept.has(tag));
}

// deploy ---------------------------------------------------------------------

async function headCommit(sys) {
  const { code, out } = await sys.git(['log', '-1', '--format=%H %s']);
  if (code !== 0) throw new Error('could not read the current commit');
  const line = out.trim();
  const at = line.indexOf(' ');
  return { commit: line.slice(0, at), subject: line.slice(at + 1) };
}

async function dirtyFiles(sys) {
  const { code, out } = await sys.git(['status', '--porcelain']);
  if (code !== 0) throw new Error('could not read the git status');
  return out.split('\n').filter((l) => l.trim());
}

/** Prints what stops the tree being deployed, and whether it does. */
async function refuseDirty(sys) {
  const dirty = await dirtyFiles(sys);
  if (dirty.length === 0) return false;
  sys.printError('Refusing: the git tree has uncommitted changes. Nothing was changed.');
  for (const line of dirty.slice(0, 10)) sys.printError(`  ${line.trim()}`);
  if (dirty.length > 10) sys.printError(`  and ${dirty.length - 10} more`);
  return true;
}

/** Returns the exit code. */
export async function runDeploy(sys, { config, stateDir, root }) {
  if (await refuseDirty(sys)) return 1;
  const { commit, subject } = await headCommit(sys);
  sys.print(`Deploying ${short(commit)}: ${subject}`);

  const deploys = loadDeploys(stateDir);
  const containers = containersOf(config);
  const backupsDir = join(stateDir, 'backups');
  const name = `${stamp(sys.now())}-${short(commit)}`;
  const entry = {
    id: name,
    kind: 'deploy',
    commit,
    subject,
    startedAt: sys.now().toISOString(),
    status: 'running',
    backup: null,
    pins: pinsOf(config),
    rolledBack: false,
  };

  sys.print(`Backing up to .katip/backups/${name}. ${NOT_OFFSITE}`);
  try {
    await takeBackup(sys, { backupsDir, name, containers, commit, kind: 'before-deploy' });
    entry.backup = name;
  } catch (e) {
    sys.printError(`Stopped: the backup failed, and nothing was changed.\n  ${e.message}`);
    sys.printError('  Is the stack running? `pnpm dev:status` says, and `pnpm dev:up` starts it.');
    saveDeploys(stateDir, [...deploys, { ...entry, status: 'backup-failed' }]);
    return 1;
  }

  try {
    const images = await currentImages(sys, config);
    const running = runningVersion(deploys, images);
    const tag = running
      ? `deploy-${short(running.commit)}`
      : `deploy-unknown-${stamp(sys.now()).toLowerCase()}`;
    entry.previous = {
      commit: running?.commit ?? null,
      pins: running?.pins ?? null,
      dbLastMigrationAt: await lastMigrationAt(sys, containers),
      images: await tagImages(sys, images, tag),
    };
    sys.print(
      `Kept the running images as :${tag}${running ? '' : ' (no earlier deploy says which commit they are from)'}`,
    );
  } catch (e) {
    sys.printError(`Stopped before rebuilding anything.\n  ${e.message}`);
    saveDeploys(stateDir, [...deploys, { ...entry, status: 'failed' }]);
    return 1;
  }

  entry.migrations = journalEntries(root).map((e) => e.tag);
  saveDeploys(stateDir, [...deploys, entry]);

  const code = await sys.runUp(DEPLOY_UP_FLAGS);
  entry.finishedAt = sys.now().toISOString();
  if (code !== 0) {
    entry.status = 'failed';
    saveDeploys(stateDir, [...deploys, entry]);
    sys.printError(`Deploy of ${short(commit)} failed. The log is under .katip/logs/.`);
    sys.printError('To go back: pnpm dev:deploy-back (add --restore-data if a migration ran).');
    return code;
  }
  entry.status = 'ok';
  entry.builtImages = (await currentImages(sys, config)).map(({ ref, id }) => ({ ref, id }));
  const all = [...deploys, entry];
  saveDeploys(stateDir, all);

  const keep = keepBackups(config);
  for (const pruned of pruneBackups(backupsDir, keep, [entry.backup])) {
    sys.print(`Pruned backup ${pruned}`);
  }
  for (const tag of imageTagsToPrune(all, keep)) await sys.docker(['rmi', tag]);
  sys.print(`Deployed ${short(commit)}. Recorded in .katip/deploys.json.`);
  return 0;
}

// back -----------------------------------------------------------------------

/** Pins whose change can leave data the older version can't read. */
const DATA_PINS = ['librechat'];

export function pinChanges(fromPins, toPins) {
  if (!fromPins || !toPins) return null;
  return Object.keys(fromPins)
    .filter((k) => fromPins[k] !== toPins[k])
    .map((k) => ({ name: k, from: fromPins[k], to: toPins[k] }));
}

/**
 * Pure. Whether going back may happen, and what to ask first. A rollback across a migration
 * needs the restore: the older code would be running on a schema it has never seen.
 */
export function decideBack({ undo, pins, restoreData, yes, interactive, project }) {
  const dataPins = (pins ?? []).filter((p) => DATA_PINS.includes(p.name));
  const needs = [];
  if (undo.unknown) needs.push('it could not be read which migrations differ');
  if (undo.tags.length > 0) needs.push(`migrations would be undone: ${undo.tags.join(', ')}`);
  if (dataPins.length > 0) {
    needs.push(
      `LibreChat changes version, and it migrates its own data: ${dataPins[0].from} to ${dataPins[0].to}`,
    );
  }
  if (needs.length > 0 && !restoreData) {
    return {
      action: 'refuse',
      message: `Refusing to go back on images alone: ${needs.join('; ')}. This needs the database restore: pnpm dev:deploy-back --restore-data. It loses everything written since the backup. Nothing was changed.`,
    };
  }
  if (restoreData) {
    if (!interactive) {
      return {
        action: 'refuse',
        message:
          'Refusing: --restore-data always asks, and there is no terminal here to ask on. Nothing was changed.',
      };
    }
    return { action: 'ask-restore', expected: project };
  }
  if (yes) return { action: 'proceed' };
  if (!interactive) {
    return {
      action: 'refuse',
      message: 'Refusing: no terminal to ask on. Use --yes. Nothing was changed.',
    };
  }
  return { action: 'ask-images' };
}

function describeBack(sys, cur, undo, pins) {
  const target = cur.previous;
  sys.print(`Going back from ${short(cur.commit)} (${cur.subject})`);
  sys.print(
    `  to ${target.commit ? short(target.commit) : 'the images running before that deploy, from an unknown commit'}`,
  );
  sys.print(`  images: ${target.images.map((i) => i.savedAs).join(', ') || 'none recorded'}`);
  if (undo.unknown) sys.print('  migrations: could not be read, so they are treated as different');
  else if (undo.tags.length === 0) sys.print('  migrations: none differ');
  else sys.print(`  migrations that differ: ${undo.tags.join(', ')}`);
  if (pins === null) sys.print('  image pins: not recorded for the earlier version');
  else for (const p of pins) sys.print(`  image pin ${p.name}: ${p.from} to ${p.to}`);
}

/** Returns the exit code. */
export async function runBack(sys, { config, stateDir, root, restoreData, yes, interactive }) {
  if (await refuseDirty(sys)) return 1;
  const deploys = loadDeploys(stateDir);
  const cur = currentDeploy(deploys);
  if (!cur) {
    sys.printError('Refusing: no deploy is recorded that could be gone back from.');
    return 1;
  }
  const project = config.project.name;
  const containers = containersOf(config);
  const backupsDir = join(stateDir, 'backups');
  const target = cur.previous;

  const undo = migrationsToUndo(
    journalEntries(root),
    target.dbLastMigrationAt,
    await lastMigrationAt(sys, containers),
  );
  const pins = pinChanges(cur.pins, target.pins);
  describeBack(sys, cur, undo, pins);

  const decision = decideBack({ undo, pins, restoreData, yes, interactive, project });
  if (decision.action === 'refuse') {
    sys.printError(decision.message);
    return 1;
  }

  // Everything that could make this fail half-way, checked before anything changes.
  for (const { savedAs, id } of target.images) {
    const r = await sys.docker(['image', 'inspect', '-f', '{{.Id}}', savedAs]);
    if (r.code !== 0 || r.out.trim() !== id) {
      sys.printError(
        `Refusing: the kept image ${savedAs} is gone or has changed. Nothing was changed.`,
      );
      return 1;
    }
  }
  if (target.commit) {
    const r = await sys.git(['cat-file', '-e', `${target.commit}^{commit}`]);
    if (r.code !== 0) {
      sys.printError(
        `Refusing: commit ${short(target.commit)} is not in this repository. Nothing was changed.`,
      );
      return 1;
    }
  }
  let manifest = null;
  if (restoreData) {
    try {
      manifest = await checkBackup(sys, { backupsDir, name: cur.backup, containers });
    } catch (e) {
      sys.printError(`Refusing: ${e.message}. Nothing was changed.`);
      return 1;
    }
  }

  if (decision.action === 'ask-restore') {
    sys.print(
      `\nThis replaces the governance database and every company's chats with the copy from ${manifest.takenAt}.`,
    );
    sys.print('EVERYTHING written since then is lost: chats, users, usage, audit entries.');
    sys.print('People or companies deleted since then come back, and must be deleted again.');
    sys.print(
      'Keycloak, uploads, file search and search indexes are not in the copy, and stay as they are.',
    );
    const answer = await sys.ask(`Type the project name (${project}) to restore: `);
    if (answer !== project) {
      sys.print('aborted: nothing was changed.');
      return 1;
    }
  } else if (decision.action === 'ask-images') {
    const answer = await sys.ask('The data stays as it is. Go back? [y/N] ');
    if (!['y', 'yes'].includes((answer ?? '').toLowerCase())) {
      sys.print('aborted: nothing was changed.');
      return 1;
    }
  }

  const { commit: from } = await headCommit(sys);
  const record = {
    id: `${stamp(sys.now())}-back`,
    kind: 'back',
    from: cur.id,
    startedAt: sys.now().toISOString(),
    restoredData: Boolean(restoreData),
    status: 'running',
  };
  const save = (status) => saveDeploys(stateDir, [...deploys, { ...record, status }]);
  save('running');

  let safety = null;
  try {
    if (restoreData) {
      safety = `${stamp(sys.now())}-${short(from)}-before-back`;
      sys.print(`Copying the data as it is now to .katip/backups/${safety}`);
      await takeBackup(sys, {
        backupsDir,
        name: safety,
        containers,
        commit: from,
        kind: 'before-back',
      });
      const nowDatabases = await tenantDatabases(sys, containers);
      await sys.stopWriters();
      const dir = join(backupsDir, cur.backup);
      for (const f of manifest.files) {
        sys.print(`Restoring ${f.database}`);
        if (f.database === 'governance')
          await restoreGovernance(sys, containers, join(dir, f.file));
        else await restoreMongo(sys, containers, f.database, join(dir, f.file));
      }
      const inCopy = new Set(manifest.files.map((f) => f.database));
      for (const database of nowDatabases.filter((d) => !inCopy.has(d))) {
        sys.print(
          `  ${database} was created after the copy and was not touched. Its company no longer has a row: see docs/runbooks/rollback.md.`,
        );
      }
    }
    for (const { ref, savedAs } of target.images) {
      const r = await sys.docker(['tag', savedAs, ref]);
      if (r.code !== 0) throw new Error(`could not restore ${ref}: ${r.out.trim()}`);
    }
    if (target.commit && target.commit !== from) {
      const r = await sys.git(['checkout', '--detach', target.commit]);
      if (r.code !== 0)
        throw new Error(`could not check out ${short(target.commit)}: ${r.out.trim()}`);
      sys.print(
        `HEAD is now detached at ${short(target.commit)}, so compose files and pins match the images.`,
      );
    } else if (!target.commit) {
      sys.print(
        'The earlier commit is not known, so the compose files and pins of this checkout stay.',
      );
    }
  } catch (e) {
    save('failed');
    sys.printError(`Going back stopped part-way: ${e.message}`);
    if (safety) sys.printError(`The data as it was before this is in .katip/backups/${safety}.`);
    sys.printError(
      'Run it again once the cause is fixed. Stopped services stay stopped until then.',
    );
    return 1;
  }

  const code = await sys.runUp(BACK_UP_FLAGS);
  if (code !== 0) {
    save('failed');
    sys.printError(
      'The images and data are back, but the stack did not come up or failed its checks.',
    );
    sys.printError('Read .katip/logs/, then run pnpm dev:deploy-back again.');
    return code;
  }
  const updated = deploys.map((d) => (d.id === cur.id ? { ...d, rolledBack: true } : d));
  saveDeploys(stateDir, [
    ...updated,
    { ...record, status: 'ok', finishedAt: sys.now().toISOString() },
  ]);
  sys.print(
    `Back on ${target.commit ? short(target.commit) : 'the earlier images'}. To deploy again, check out a branch first.`,
  );
  return 0;
}
