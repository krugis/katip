// SPDX-License-Identifier: AGPL-3.0-only
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupsToPrune, stamp } from '../backups.mjs';
import { validateConfig } from '../config.mjs';
import {
  BACK_UP_FLAGS,
  DEPLOY_UP_FLAGS,
  currentDeploy,
  decideBack,
  imageTagsToPrune,
  keepBackups,
  loadDeploys,
  migrationsToUndo,
  pinChanges,
  runBack,
  runDeploy,
  runningVersion,
  savedRef,
  selfBuiltImages,
} from '../deploy-lib.mjs';

const COMMIT = 'a'.repeat(40);
const OLD_COMMIT = 'b'.repeat(40);

const config = {
  project: { name: 'katip' },
  images: {
    postgres: 'pgvector/pgvector:1',
    librechat: 'ghcr.io/danny-avila/librechat:v1',
    litellm: { version: '1.0', sha256: 'x' },
    presidio_analyzer: { version: '2.0' },
  },
};

/** A fake machine: git, Docker and dev:up, recording the order of everything that changes it. */
function machine(root, over = {}) {
  const state = {
    log: [],
    dirty: '',
    head: COMMIT,
    tags: new Map(selfBuiltImages(config).map((ref) => [ref, `sha256:old-${ref}`])),
    lastMigration: 200,
    dumpFails: null,
    emptyDump: false,
    upCode: 0,
    ...over,
  };
  const ok = (out = '') => ({ code: 0, out });
  const sys = {
    state,
    now: () => new Date('2026-11-03T12:00:00.000Z'),
    print: vi.fn(),
    printError: vi.fn(),
    ask: vi.fn(async () => null),
    runUp: vi.fn(async (flags) => {
      state.log.push(`up ${flags.join(' ')}`);
      if (state.upCode === 0 && state.rebuilds) {
        for (const ref of selfBuiltImages(config))
          state.tags.set(ref, `sha256:new-${state.head}-${ref}`);
      }
      return state.upCode;
    }),
    stopWriters: vi.fn(async () => {
      state.log.push('stop writers');
    }),
    git: vi.fn(async (args) => {
      if (args[0] === 'status') return ok(state.dirty);
      if (args[0] === 'log') return ok(`${state.head} a subject\n`);
      if (args[0] === 'cat-file') return { code: state.noCommit ? 1 : 0, out: '' };
      if (args[0] === 'checkout') {
        state.log.push(`checkout ${args.at(-1)}`);
        return ok();
      }
      throw new Error(`unexpected git ${args.join(' ')}`);
    }),
    docker: vi.fn(async (args) => {
      const text = args.join(' ');
      if (args[0] === 'ps') return ok('');
      if (args[0] === 'inspect') return ok('');
      if (args[0] === 'image') {
        const id = state.tags.get(args.at(-1));
        return id ? ok(`${id}\n`) : { code: 1, out: 'No such image' };
      }
      if (args[0] === 'tag') {
        if (state.tagFails) return { code: 1, out: 'tag failed' };
        state.log.push(`tag ${args[2]}`);
        const id = args[1].startsWith('sha256:') ? args[1] : state.tags.get(args[1]);
        state.tags.set(args[2], id);
        return ok();
      }
      if (args[0] === 'rmi') {
        state.log.push(`rmi ${args[1]}`);
        return ok();
      }
      if (text.includes('__drizzle_migrations')) return ok(`${state.lastMigration}\n`);
      if (text.includes('listDatabases')) return ok('["lc_acme"]\n');
      if (text.includes('stats().objects')) return ok('3\n');
      if (text.includes('DROP DATABASE') || text.includes('ALTER DATABASE')) {
        state.log.push(text.includes('RENAME TO governance') ? 'swap governance' : 'pg admin');
        return ok();
      }
      if (text.includes('dropDatabase')) {
        state.log.push('drop mongo');
        return ok();
      }
      return ok('0\n');
    }),
    dockerToFile: vi.fn(async (args, file) => {
      if (state.dumpFails) return { code: 1, out: state.dumpFails };
      state.log.push(
        `dump ${args.includes('pg_dump') || args.join(' ').includes('pg_dump') ? 'pg' : 'mongo'}`,
      );
      if (args.join(' ').includes('pg_dump')) {
        writeFileSync(file, state.emptyDump ? '' : 'PGDMP');
      } else {
        writeFileSync(file, gzipSync(state.emptyDump ? '' : 'archive'));
      }
      return ok();
    }),
    dockerFromFile: vi.fn(async (args) => {
      const text = args.join(' ');
      if (text.includes('pg_restore -l') || (args.includes('pg_restore') && args.includes('-l'))) {
        return ok(state.noTenants ? 'nothing' : '; 3 TABLE DATA public tenants katip');
      }
      if (text.includes('--dryRun')) return ok('archive prelude lc_acme.users');
      state.log.push(text.includes('mongorestore') ? 'restore mongo' : 'restore pg');
      return ok();
    }),
  };
  return sys;
}

const log = (sys) => sys.state.log;
const printed = (sys) => sys.print.mock.calls.map(([l]) => l).join('\n');
const errors = (sys) => sys.printError.mock.calls.map(([l]) => l).join('\n');

let stateDir;
let root;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  root = mkdtempSync(join(tmpdir(), 'deploy-root-'));
  mkdirSync(join(root, 'packages', 'db', 'drizzle', 'meta'), { recursive: true });
  writeFileSync(
    join(root, 'packages', 'db', 'drizzle', 'meta', '_journal.json'),
    JSON.stringify({
      entries: [
        { tag: '0000_schema', when: 100 },
        { tag: '0001_new', when: 200 },
      ],
    }),
  );
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});
const where = () => ({ config, stateDir, root });

describe('runDeploy', () => {
  it('refuses uncommitted changes, before touching anything', async () => {
    const sys = machine(root, { dirty: ' M apps/x.ts\n?? new.txt\n' });
    expect(await runDeploy(sys, where())).toBe(1);
    expect(errors(sys)).toContain('uncommitted changes');
    expect(errors(sys)).toContain('apps/x.ts');
    expect(log(sys)).toEqual([]);
    expect(sys.runUp).not.toHaveBeenCalled();
  });

  it('says which commit it is deploying', async () => {
    const sys = machine(root);
    await runDeploy(sys, where());
    expect(printed(sys)).toContain(`Deploying ${COMMIT.slice(0, 12)}: a subject`);
  });

  it('backs up, then tags, then rebuilds through the --redo machinery', async () => {
    const sys = machine(root);
    expect(await runDeploy(sys, where())).toBe(0);
    const l = log(sys);
    const firstTag = l.findIndex((x) => x.startsWith('tag'));
    const up = l.findIndex((x) => x.startsWith('up'));
    expect(l.indexOf('dump pg')).toBeLessThan(firstTag);
    expect(l.indexOf('dump mongo')).toBeLessThan(firstTag);
    expect(firstTag).toBeLessThan(up);
    expect(sys.runUp).toHaveBeenCalledWith(DEPLOY_UP_FLAGS);
    for (const step of [
      'config',
      'build',
      'governance-db',
      'aiplane',
      'tenant',
      'smoke',
      'isolation',
    ]) {
      expect(DEPLOY_UP_FLAGS[0]).toContain(step);
    }
  });

  it('writes each dump in a mode 700 directory, and says it is not the off-site backup', async () => {
    const sys = machine(root);
    await runDeploy(sys, where());
    const [dir] = readdirSync(join(stateDir, 'backups'));
    expect(dir).toBe(`20261103T120000Z-${COMMIT.slice(0, 12)}`);
    const path = join(stateDir, 'backups', dir);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, 'backups')).mode & 0o777).toBe(0o700);
    const manifest = JSON.parse(readFileSync(join(path, 'manifest.json'), 'utf8'));
    expect(manifest.files.map((f) => f.database)).toEqual(['governance', 'lc_acme']);
    expect(manifest.note).toContain('P1-42');
    expect(printed(sys)).toContain('P1-42');
  });

  it.each([
    ['fails', { dumpFails: 'pg_dump: connection refused' }, 'connection refused'],
    ['is empty', { emptyDump: true }, 'empty'],
    ['has no tenants table', { noTenants: true }, 'no tenants table'],
  ])('stops before changing anything when the dump %s', async (_name, over, message) => {
    const sys = machine(root, over);
    expect(await runDeploy(sys, where())).toBe(1);
    expect(errors(sys)).toContain(message);
    expect(errors(sys)).toContain('nothing was changed');
    expect(log(sys).some((x) => x.startsWith('tag') || x.startsWith('up'))).toBe(false);
    expect(sys.runUp).not.toHaveBeenCalled();
    expect(readdirSync(join(stateDir, 'backups'))).toEqual([]);
    expect(loadDeploys(stateDir)[0].status).toBe('backup-failed');
  });

  it('stops before rebuilding when tagging fails', async () => {
    const sys = machine(root, { tagFails: true });
    expect(await runDeploy(sys, where())).toBe(1);
    expect(sys.runUp).not.toHaveBeenCalled();
    expect(loadDeploys(stateDir)[0].status).toBe('failed');
  });

  it('never puts a password on a command line', async () => {
    const sys = machine(root);
    await runDeploy(sys, where());
    const lines = [
      ...sys.docker.mock.calls,
      ...sys.dockerToFile.mock.calls,
      ...sys.dockerFromFile.mock.calls,
    ].map(([a]) => a.join(' '));
    expect(lines.some((l) => l.includes('mongodump'))).toBe(true);
    for (const l of lines) {
      expect(l).not.toMatch(/PASSWORD=/);
      if (l.includes('--password')) expect(l).toContain('--password "$MONGO_INITDB_ROOT_PASSWORD"');
    }
  });

  it('records a good deploy, with what it needs to go back', async () => {
    const sys = machine(root, { rebuilds: true });
    await runDeploy(sys, where());
    const [d] = loadDeploys(stateDir);
    expect(d).toMatchObject({ kind: 'deploy', commit: COMMIT, status: 'ok', rolledBack: false });
    expect(d.previous.dbLastMigrationAt).toBe(200);
    expect(d.previous.commit).toBeNull();
    expect(d.previous.images[0].savedAs).toContain(':deploy-unknown-');
    expect(d.previous.images[0].id).toContain('sha256:old-');
    expect(d.builtImages[0].id).toContain('sha256:new-');
    expect(d.migrations).toEqual(['0000_schema', '0001_new']);
  });

  it('records a failure, returns its code and points the way back', async () => {
    const sys = machine(root, { upCode: 130 });
    expect(await runDeploy(sys, where())).toBe(130);
    expect(loadDeploys(stateDir)[0].status).toBe('failed');
    expect(errors(sys)).toContain('pnpm deploy:back');
  });

  it('tags by commit when an earlier deploy says which one is running', async () => {
    const sys = machine(root, { rebuilds: true, head: OLD_COMMIT });
    await runDeploy(sys, where());
    sys.state.head = COMMIT;
    await runDeploy(sys, where());
    const second = loadDeploys(stateDir)[1];
    expect(second.previous.commit).toBe(OLD_COMMIT);
    expect(second.previous.images[0].savedAs).toContain(`:deploy-${OLD_COMMIT.slice(0, 12)}`);
  });

  it("doesn't trust the record if the images changed behind its back", async () => {
    const sys = machine(root, { rebuilds: true, head: OLD_COMMIT });
    await runDeploy(sys, where());
    sys.state.tags.set('ghcr.io/krugis/console:dev', 'sha256:someone-rebuilt-it');
    sys.state.head = COMMIT;
    await runDeploy(sys, where());
    const second = loadDeploys(stateDir)[1];
    expect(second.previous.commit).toBeNull();
    expect(second.previous.images[0].savedAs).toContain(':deploy-unknown-');
  });

  it('a deploy stopped at its backup changed nothing, so the record still holds', async () => {
    const sys = machine(root, { rebuilds: true, head: OLD_COMMIT });
    await runDeploy(sys, where());
    sys.state.head = COMMIT;
    sys.state.dumpFails = 'no space';
    expect(await runDeploy(sys, where())).toBe(1);
    expect(loadDeploys(stateDir).at(-1).status).toBe('backup-failed');
    expect(currentDeploy(loadDeploys(stateDir)).commit).toBe(OLD_COMMIT);
  });

  it('prunes old backups to the configured count, and their image tags', async () => {
    const sys = machine(root, { rebuilds: true });
    const c = { ...config, deploy: { keep_backups: 2 } };
    for (const [i, name] of [
      '20260101T000000Z-x',
      '20260102T000000Z-x',
      '20260103T000000Z-x',
    ].entries()) {
      mkdirSync(join(stateDir, 'backups', name), { recursive: true });
      expect(i).toBeLessThan(3);
    }
    writeFileSync(
      join(stateDir, 'deploys.json'),
      JSON.stringify({
        deploys: [
          { kind: 'deploy', id: 'd1', previous: { images: [{ savedAs: 'x:deploy-old' }] } },
          { kind: 'deploy', id: 'd2', previous: { images: [{ savedAs: 'x:deploy-mid' }] } },
        ],
      }),
    );
    await runDeploy(sys, { config: c, stateDir, root });
    const left = readdirSync(join(stateDir, 'backups'));
    expect(left).toHaveLength(2);
    expect(left).toContain(`20261103T120000Z-${COMMIT.slice(0, 12)}`);
    expect(log(sys)).toContain('rmi x:deploy-old');
    expect(log(sys)).not.toContain('rmi x:deploy-mid');
  });
});

describe('keeping backups', () => {
  it('keeps the newest, plus what is protected', () => {
    expect(backupsToPrune(['20260101', '20260103', '20260102'], 1)).toEqual([
      '20260102',
      '20260101',
    ]);
    expect(backupsToPrune(['20260101', '20260102'], 1, ['20260101'])).toEqual([]);
  });

  it('defaults to 5, and the config can change it', () => {
    expect(keepBackups(config)).toBe(5);
    expect(keepBackups({ deploy: { keep_backups: 2 } })).toBe(2);
  });

  it('validates the setting', () => {
    const errorsFor = (deploy) => validateConfig({ deploy }).filter((e) => e.startsWith('deploy'));
    expect(errorsFor({ keep_backups: 3 })).toEqual([]);
    expect(errorsFor({ keep_backups: 0 })).toHaveLength(1);
    expect(errorsFor({ keep_backups: 'x' })).toHaveLength(1);
    expect(errorsFor({ other: 1, keep_backups: 1 })).toEqual(['deploy.other: unknown setting']);
  });

  it('prunes only the tags no kept deploy uses', () => {
    const d = (tag) => ({ kind: 'deploy', previous: { images: [{ savedAs: tag }] } });
    expect(imageTagsToPrune([d('a'), d('b'), d('b'), d('c')], 2)).toEqual(['a']);
    expect(imageTagsToPrune([d('a')], 5)).toEqual([]);
  });

  it('stamps sort by time', () => {
    expect(stamp(new Date('2026-11-03T12:00:00.000Z'))).toBe('20261103T120000Z');
  });
});

describe('small rules', () => {
  it('saves a tag under the same repository, whatever the old tag', () => {
    expect(savedRef('ghcr.io/krugis/litellm:1.79.3', 'deploy-abc')).toBe(
      'ghcr.io/krugis/litellm:deploy-abc',
    );
  });

  it('names the migrations to undo, and treats unknown as a difference', () => {
    const entries = [
      { tag: 'a', when: 1 },
      { tag: 'b', when: 2 },
      { tag: 'c', when: 3 },
    ];
    expect(migrationsToUndo(entries, 1, 3)).toEqual({ unknown: false, tags: ['b', 'c'] });
    expect(migrationsToUndo(entries, 3, 3)).toEqual({ unknown: false, tags: [] });
    // A deploy that failed before it migrated has nothing to undo.
    expect(migrationsToUndo(entries, 2, 2).tags).toEqual([]);
    expect(migrationsToUndo(entries, null, 3).unknown).toBe(true);
    // A database ahead of this checkout's journal is a difference, though no name fits it.
    expect(migrationsToUndo(entries, 3, 9).unknown).toBe(true);
    expect(migrationsToUndo(entries, 3, null).unknown).toBe(true);
  });

  it('finds the current deploy, skipping those gone back from', () => {
    const list = [
      { kind: 'deploy', id: 1, previous: {} },
      { kind: 'back', id: 2 },
      { kind: 'deploy', id: 3, previous: {}, rolledBack: true },
      { kind: 'deploy', id: 4, status: 'backup-failed' },
    ];
    expect(currentDeploy(list).id).toBe(1);
    expect(currentDeploy([])).toBeNull();
  });

  it('knows the running version only from a finished deploy', () => {
    const images = [{ ref: 'r', id: 'i' }];
    const good = { kind: 'deploy', status: 'ok', previous: {}, builtImages: images };
    expect(runningVersion([good], images)).toBe(good);
    expect(runningVersion([{ ...good, status: 'failed' }], images)).toBeNull();
    expect(runningVersion([good], [{ ref: 'r', id: 'other' }])).toBeNull();
    expect(runningVersion([], images)).toBeNull();
  });

  it('compares pins, and says when it cannot', () => {
    expect(pinChanges({ a: '1', b: '2' }, { a: '1', b: '3' })).toEqual([
      { name: 'b', from: '2', to: '3' },
    ]);
    expect(pinChanges({ a: '1' }, null)).toBeNull();
  });
});

describe('decideBack', () => {
  const same = { unknown: false, tags: [] };
  const base = { undo: same, pins: [], project: 'katip', interactive: true };

  it('asks plainly for images alone, and --yes skips that', () => {
    expect(decideBack(base).action).toBe('ask-images');
    expect(decideBack({ ...base, yes: true, interactive: false }).action).toBe('proceed');
  });

  it('refuses without a terminal and without --yes', () => {
    expect(decideBack({ ...base, interactive: false }).action).toBe('refuse');
  });

  it('refuses images alone across a migration, and says the restore is needed', () => {
    const d = decideBack({ ...base, yes: true, undo: { unknown: false, tags: ['0004_x'] } });
    expect(d.action).toBe('refuse');
    expect(d.message).toContain('0004_x');
    expect(d.message).toContain('--restore-data');
  });

  it('refuses images alone when the migrations cannot be read', () => {
    const d = decideBack({ ...base, yes: true, undo: { unknown: true, tags: [] } });
    expect(d.action).toBe('refuse');
  });

  it('refuses images alone across a LibreChat version', () => {
    const pins = [{ name: 'librechat', from: 'v2', to: 'v1' }];
    expect(decideBack({ ...base, yes: true, pins }).action).toBe('refuse');
    expect(
      decideBack({ ...base, yes: true, pins: [{ name: 'valkey', from: '2', to: '1' }] }).action,
    ).toBe('proceed');
  });

  it('always asks for a restore: --yes does not skip it, and no terminal refuses', () => {
    expect(decideBack({ ...base, restoreData: true, yes: true }).action).toBe('ask-restore');
    expect(decideBack({ ...base, restoreData: true, yes: true, interactive: false }).action).toBe(
      'refuse',
    );
  });
});

describe('runBack', () => {
  /** A deploy of COMMIT over OLD_COMMIT, with a migration when the fake says so. */
  async function deployed(over = {}) {
    const sys = machine(root, { rebuilds: true, head: OLD_COMMIT });
    await runDeploy(sys, where());
    sys.state.head = COMMIT;
    sys.state.lastMigration = 200;
    await runDeploy(sys, where());
    Object.assign(sys.state, over, { log: [] });
    sys.runUp.mockClear();
    return sys;
  }
  const backArgs = (extra) => ({ ...where(), interactive: true, ...extra });

  it('refuses with nothing to go back from', async () => {
    const sys = machine(root);
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
    expect(errors(sys)).toContain('no deploy is recorded');
  });

  it('refuses uncommitted changes', async () => {
    const sys = await deployed({ dirty: ' M x\n' });
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
    expect(log(sys)).toEqual([]);
  });

  it('restores the kept images, checks out their commit and brings it up, no build', async () => {
    const sys = await deployed();
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(0);
    const l = log(sys);
    expect(l.filter((x) => x.startsWith('tag'))).toHaveLength(selfBuiltImages(config).length);
    expect(l).toContain(`checkout ${OLD_COMMIT}`);
    expect(sys.runUp).toHaveBeenCalledWith(BACK_UP_FLAGS);
    expect(BACK_UP_FLAGS.join(' ')).toContain('--skip=build,images');
    expect(BACK_UP_FLAGS[0]).not.toContain('build');
    expect(l.some((x) => x.includes('mongo') || x.includes('swap'))).toBe(false);
    expect(sys.state.tags.get('ghcr.io/krugis/console:dev')).toContain('sha256:new-');
    const rec = loadDeploys(stateDir);
    expect(rec.at(-1)).toMatchObject({ kind: 'back', status: 'ok', restoredData: false });
    expect(rec.filter((d) => d.kind === 'deploy').at(-1).rolledBack).toBe(true);
  });

  it('asks plainly first when not told --yes, and no means nothing changes', async () => {
    const sys = await deployed();
    sys.ask.mockResolvedValue('n');
    expect(await runBack(sys, backArgs())).toBe(1);
    expect(sys.ask.mock.calls[0][0]).toContain('The data stays');
    expect(log(sys)).toEqual([]);
    expect(sys.runUp).not.toHaveBeenCalled();
  });

  it('refuses images alone across a migration, and shows which', async () => {
    const sys = await deployed();
    // The previous deploy saw 100; this one migrated to 200.
    const file = join(stateDir, 'deploys.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.deploys.at(-1).previous.dbLastMigrationAt = 100;
    writeFileSync(file, JSON.stringify(data));
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
    expect(printed(sys)).toContain('migrations that differ: 0001_new');
    expect(errors(sys)).toContain('--restore-data');
    expect(log(sys)).toEqual([]);
  });

  it('treats a kept image that has gone as a refusal, before anything changes', async () => {
    const sys = await deployed();
    const rec = loadDeploys(stateDir).at(-1);
    sys.state.tags.delete(rec.previous.images[0].savedAs);
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
    expect(errors(sys)).toContain('gone or has changed');
    expect(log(sys)).toEqual([]);
  });

  it('refuses when the commit is no longer in the repository', async () => {
    const sys = await deployed({ noCommit: true });
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
    expect(log(sys)).toEqual([]);
  });

  describe('with --restore-data', () => {
    it('demands the exact name, and says plainly what is lost', async () => {
      const sys = await deployed();
      sys.ask.mockResolvedValue('y');
      expect(await runBack(sys, backArgs({ restoreData: true }))).toBe(1);
      expect(printed(sys)).toContain('EVERYTHING written since then is lost');
      expect(printed(sys)).toContain('deleted since then come back');
      expect(log(sys)).toEqual([]);
    });

    it('refuses without a terminal, even with --yes', async () => {
      const sys = await deployed();
      expect(
        await runBack(sys, backArgs({ restoreData: true, yes: true, interactive: false })),
      ).toBe(1);
      expect(log(sys)).toEqual([]);
    });

    it('copies the data, stops writers, restores, and only then brings the old version up', async () => {
      const sys = await deployed();
      sys.ask.mockResolvedValue('katip');
      expect(await runBack(sys, backArgs({ restoreData: true }))).toBe(0);
      const l = log(sys);
      const order = [
        'dump pg',
        'stop writers',
        'restore pg',
        'swap governance',
        'drop mongo',
        'restore mongo',
      ];
      const at = order.map((x) => l.indexOf(x));
      expect(at).not.toContain(-1);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(l.indexOf('restore mongo')).toBeLessThan(l.findIndex((x) => x.startsWith('tag')));
      expect(l.findIndex((x) => x.startsWith('checkout'))).toBeLessThan(
        l.findIndex((x) => x.startsWith('up')),
      );
      expect(readdirSync(join(stateDir, 'backups')).some((n) => n.endsWith('-before-back'))).toBe(
        true,
      );
      expect(loadDeploys(stateDir).at(-1).restoredData).toBe(true);
    });

    it('stops if the copy of the present data fails, with nothing dropped', async () => {
      const sys = await deployed();
      sys.ask.mockResolvedValue('katip');
      sys.state.dumpFails = 'disk full';
      expect(await runBack(sys, backArgs({ restoreData: true }))).toBe(1);
      expect(sys.stopWriters).not.toHaveBeenCalled();
      expect(log(sys).some((x) => x.includes('restore') || x.includes('drop'))).toBe(false);
    });

    it('refuses a backup that has been pruned, or altered', async () => {
      const sys = await deployed();
      sys.ask.mockResolvedValue('katip');
      const { backup } = loadDeploys(stateDir).at(-1);
      writeFileSync(join(stateDir, 'backups', backup, 'governance.dump'), 'changed');
      expect(await runBack(sys, backArgs({ restoreData: true }))).toBe(1);
      expect(errors(sys)).toContain('missing or has changed');
      rmSync(join(stateDir, 'backups', backup), { recursive: true });
      expect(await runBack(sys, backArgs({ restoreData: true }))).toBe(1);
      expect(errors(sys)).toContain('pruned');
      expect(log(sys)).toEqual([]);
    });
  });

  it('can be repeated after a failed start, and goes back to the same version', async () => {
    const sys = await deployed({ upCode: 1 });
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
    expect(
      loadDeploys(stateDir)
        .filter((d) => d.kind === 'deploy')
        .at(-1).rolledBack,
    ).toBe(false);
    sys.state.upCode = 0;
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(0);
    expect(log(sys).filter((x) => x === `checkout ${OLD_COMMIT}`)).toHaveLength(2);
  });

  it('a second go back reaches the deploy before that', async () => {
    const sys = await deployed();
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(0);
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(0);
    const deploys = loadDeploys(stateDir).filter((d) => d.kind === 'deploy');
    expect(deploys.every((d) => d.rolledBack)).toBe(true);
    expect(existsSync(join(stateDir, 'deploys.json'))).toBe(true);
    expect(await runBack(sys, backArgs({ yes: true }))).toBe(1);
  });
});
