// SPDX-License-Identifier: AGPL-3.0-only
// The real commands, from a copy of the scripts in a temp directory, with fake docker, git and
// crontab first on the PATH. Nothing here can reach the stack, and no real rollback runs.
import { spawn } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const FAKE_DOCKER = `#!/bin/sh
echo "docker $*" >> "$FAKE_LOG"
gone() { grep -q 'down -v' "$FAKE_LOG" && [ "$FAKE_MODE" != left-behind ]; }
case "$*" in
  'volume ls'*)
    [ "$FAKE_MODE" = no-docker ] && exit 1
    gone || echo katip_pgdata
    ;;
  *to_regclass*) [ "$FAKE_MODE" = no-database ] && exit 1; echo t ;;
  *json_agg*)
    if [ "$FAKE_MODE" = real ]; then
      echo '[{"slug":"newco","status":"active","users":[{"email":"ayse@newco.com.tr","status":"active"}]}]'
    else
      echo '[{"slug":"demo","status":"active","users":[{"email":"demo@example.com","status":"active"}]}]'
    fi
    ;;
  *listDatabases*) [ "$FAKE_MODE" = no-database ] && exit 1; echo '[{"db":"lc_demo","users":[],"chats":0,"chatOwners":[]}]' ;;
  pull*) exec sleep 30 ;;
  'network inspect -f'*) exit 0 ;;
  'network inspect'*) exit 1 ;;
  *compose*'down -v'*) [ "$FAKE_MODE" = down-fails ] && { echo 'volume is in use' >&2; exit 1; } ; exit 0 ;;
esac
exit 0
`;
const FAKE_GIT = `#!/bin/sh
case "$1" in
  status) printf '%s' "$FAKE_DIRTY" ;;
  log) echo 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa a subject' ;;
esac
exit 0
`;

let root;
let log;
let secrets;

function fake(dir, name, body) {
  writeFileSync(join(dir, name), body);
  chmodSync(join(dir, name), 0o755);
}

function command(args, mode, extraEnv = {}) {
  const p = spawn(process.execPath, args, {
    cwd: root,
    env: {
      PATH: `${join(root, 'fake-bin')}:/usr/bin:/bin`,
      FAKE_LOG: log,
      FAKE_MODE: mode,
      NO_COLOR: '1',
      ...extraEnv,
    },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const done = new Promise((resolve) => p.on('close', (code) => resolve({ code, out })));
  const until = async (text) => {
    for (let i = 0; i < 300 && !out.includes(text); i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (!out.includes(text)) throw new Error(`never saw "${text}" in:\n${out}`);
  };
  return { p, done, until };
}

const rollback = (mode, ...flags) => {
  const c = command(['scripts/setup/main.mjs', 'rollback', ...flags], mode);
  c.p.stdin.end();
  return c.done;
};

const removedAnything = () => {
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return text.includes('down -v') || text.includes('network rm');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rollback-cli-'));
  log = join(root, 'fake.log');
  cpSync(join(REPO, 'scripts', 'setup'), join(root, 'scripts', 'setup'), { recursive: true });
  cpSync(join(REPO, 'katip.config.yaml'), join(root, 'katip.config.yaml'));
  for (const file of [
    'env/katip.example.env',
    'env/tenant.example.env',
    'env/tenant.rag.example.env',
    'litellm/config.dev.tmpl.yaml',
    'librechat/librechat.tmpl.yaml',
    'compose/tenant.tmpl.yml',
    'monitoring/alertmanager/alertmanager.tmpl.yml',
    'monitoring/blackbox/blackbox.tmpl.yml',
  ]) {
    cpSync(join(REPO, 'infra', file), join(root, 'infra', file), { recursive: true });
  }
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  fake(bin, 'docker', FAKE_DOCKER);
  fake(bin, 'git', FAKE_GIT);
  fake(bin, 'crontab', '#!/bin/sh\nexit 0\n');
  fake(bin, 'ss', '#!/bin/sh\nexit 0\n');
  fake(bin, 'df', "#!/bin/sh\necho header\necho 'x 1 1 99999 1% /'\n");
  secrets = join(root, 'infra', 'env', 'tenants', 'demo.secrets.env');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('pnpm dev:rollback', () => {
  it('--yes on demo data removes it and says complete', async () => {
    const { code, out } = await rollback('demo', '--yes');
    expect(out).toContain('demo');
    expect(out).toContain('Only test data');
    expect(out).toContain('rollback complete');
    expect(code).toBe(0);
    expect(removedAnything()).toBe(true);
    expect(existsSync(secrets)).toBe(false);
  });

  it('--yes on real data refuses, exits non-zero and removes nothing', async () => {
    const { code, out } = await rollback('real', '--yes');
    expect(code).toBe(1);
    expect(out).toContain('newco');
    expect(out).toContain('--destroy-data katip');
    expect(out).not.toContain('complete');
    expect(removedAnything()).toBe(false);
    expect(existsSync(secrets)).toBe(true);
  });

  it('--yes refuses when the databases cannot be read', async () => {
    const { code, out } = await rollback('no-database', '--yes');
    expect(code).toBe(1);
    expect(out).toContain('could not read the governance database');
    expect(removedAnything()).toBe(false);
  });

  it('no terminal and no flag refuses on real data, and when input ends on demo data', async () => {
    const real = await rollback('real');
    expect(real.code).toBe(1);
    const demo = await rollback('demo');
    expect(demo.code).toBe(1);
    expect(removedAnything()).toBe(false);
  });

  it('--destroy-data needs the exact project name', async () => {
    const wrong = await rollback('real', '--destroy-data', 'KATIP');
    expect(wrong.code).toBe(1);
    expect(removedAnything()).toBe(false);
    const right = await rollback('real', '--destroy-data', 'katip');
    expect(right.code).toBe(0);
    expect(removedAnything()).toBe(true);
  });

  it('a piped y still works on demo data', async () => {
    const c = command(['scripts/setup/main.mjs', 'rollback'], 'demo');
    await c.until('[y/N]');
    c.p.stdin.end('y\n');
    expect((await c.done).code).toBe(0);
    expect(removedAnything()).toBe(true);
  });

  it('reports a failed teardown, exits non-zero and keeps the secrets', async () => {
    const { code, out } = await rollback('down-fails', '--yes');
    expect(code).toBe(1);
    expect(out).toContain('rollback did NOT finish');
    expect(out).toContain('volume is in use');
    expect(out).not.toContain('rollback complete');
    expect(existsSync(secrets)).toBe(true);
  });

  it('reports what a quiet teardown left behind', async () => {
    const { code, out } = await rollback('left-behind', '--yes');
    expect(code).toBe(1);
    expect(out).toContain('volume katip_pgdata is still there');
    expect(out).not.toContain('rollback complete');
    expect(existsSync(secrets)).toBe(true);
  });
});

describe('r at the Ctrl+C prompt of pnpm dev:up', () => {
  const interrupted = async (mode) => {
    const c = command(['scripts/setup/main.mjs', 'up'], mode);
    await c.until('Platform images');
    await new Promise((r) => setTimeout(r, 200));
    c.p.kill('SIGINT');
    await c.until('choose [K/r/q]');
    c.p.stdin.write('r\n');
    return c;
  };

  it('gets the same refusal on real data, without a terminal', async () => {
    const c = await interrupted('real');
    c.p.stdin.end();
    const { code, out } = await c.done;
    expect(out).toContain('newco');
    expect(out).toContain('--destroy-data katip');
    expect(out).toContain('kept current state');
    expect(code).toBe(1);
    expect(removedAnything()).toBe(false);
    expect(existsSync(secrets)).toBe(true);
  }, 30_000);

  it('shows demo data, asks, and on yes really runs the teardown', async () => {
    const c = await interrupted('demo');
    await c.until('[y/N]');
    c.p.stdin.end('y\n');
    const { code, out } = await c.done;
    expect(out).toContain('Only test data');
    expect(out).toContain('rollback complete');
    expect(code).toBe(0);
    expect(removedAnything()).toBe(true);
  }, 30_000);

  it('on no, keeps everything', async () => {
    const c = await interrupted('demo');
    await c.until('[y/N]');
    c.p.stdin.end('n\n');
    const { code, out } = await c.done;
    expect(out).toContain('kept current state');
    expect(code).toBe(130);
    expect(removedAnything()).toBe(false);
  }, 30_000);

  it('k stays what it was, except that the exit says it did not finish', async () => {
    const c = command(['scripts/setup/main.mjs', 'up'], 'real');
    await c.until('Platform images');
    await new Promise((r) => setTimeout(r, 200));
    c.p.kill('SIGINT');
    await c.until('choose [K/r/q]');
    c.p.stdin.end('k\n');
    const { code, out } = await c.done;
    expect(out).toContain('kept current state');
    expect(code).toBe(130);
    expect(removedAnything()).toBe(false);
  }, 30_000);
});

describe('pnpm dev:deploy, the refusals', () => {
  it('refuses a dirty tree without calling docker', async () => {
    const c = command(['scripts/setup/deploy.mjs', 'deploy'], 'demo', { FAKE_DIRTY: ' M a.ts\n' });
    const { code, out } = await c.done;
    expect(code).toBe(1);
    expect(out).toContain('uncommitted changes');
    expect(existsSync(log)).toBe(false);
  });

  it('dev:deploy-back says when there is nothing to go back from', async () => {
    const c = command(['scripts/setup/deploy.mjs', 'back', '--yes'], 'demo');
    const { code, out } = await c.done;
    expect(code).toBe(1);
    expect(out).toContain('no deploy is recorded');
  });
});
