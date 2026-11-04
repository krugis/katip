// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm test:lago`: Lago and billing-bridge for real, on throwaway containers and networks of
// their own, from infra/compose/billing.yml as dev:up runs it. Touches nothing of the running
// stack, and removes everything it made, whatever happens. Made-up companies and usage only.
//
// It checks that setup creates the plans and does nothing the second time; that a test customer
// and subscription come from attach; that usage goes in, a replay of every event doesn't change
// what Lago bills, usage arriving late for a sent hour is billed once, a seat change reaches
// Lago, and Lago's own current usage matches usage_events (LLD-06 §7). It reports Lago's start
// time and its memory once idle.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeEnv, loadConfig } from './config.mjs';
import { AUTO_KEYS } from './steps.mjs';
import { ROOT, generatorFor, run, tryRun } from './util.mjs';

const config = loadConfig();
const id = randomBytes(3).toString('hex');
const project = `katip-lagocheck-${id}`;
const image = `ghcr.io/krugis/billing-bridge:lagocheck-${id}`;
const dir = mkdtempSync(join(tmpdir(), 'katip-lagocheck-'));
const LAGO = ['lago-db', 'lago-redis', 'lago-api', 'lago-worker', 'lago-clock'];

const secrets = Object.fromEntries(
  [...AUTO_KEYS].filter((k) => k.startsWith('LAGO_')).map((k) => [k, generatorFor(k)()]),
);
secrets.KATIP_BILLING_DB_PASSWORD = generatorFor('KATIP_BILLING_DB_PASSWORD')();
const adminPassword = generatorFor('POSTGRES_PASSWORD')();
const env = {
  ...composeEnv(config),
  ...secrets,
  KATIP_COMPOSE_PROJECT: project,
  ADMIN_DATABASE_URL: `postgres://katip:${adminPassword}@postgres:5432/governance`,
};
const envFile = join(dir, 'check.env');
writeFileSync(
  envFile,
  `${Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`,
  { mode: 0o600 },
);

// The governance DB stands in for ours, and billing-bridge runs the image built here.
const overlay = join(dir, 'overlay.yml');
writeFileSync(
  overlay,
  JSON.stringify({
    services: {
      postgres: {
        image: config.images.postgres,
        environment: {
          POSTGRES_USER: 'katip',
          POSTGRES_PASSWORD: adminPassword,
          POSTGRES_DB: 'governance',
        },
        networks: ['backend'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U katip -d governance'],
          interval: '2s',
          retries: 60,
        },
      },
      'billing-bridge': { image },
    },
    networks: { backend: { name: `${project}_backend` } },
  }),
);

const compose = (args, opts = {}) =>
  tryRun(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-p',
      project,
      '-f',
      'infra/compose/billing.yml',
      '-f',
      overlay,
      ...args,
    ],
    { env, timeoutMs: 900_000, ...opts },
  );

const result = (out, prefix) => {
  const line = out.split('\n').find((l) => l.startsWith(prefix));
  if (!line) throw new Error(`no ${prefix} in: ${out.slice(-600)}`);
  return JSON.parse(line.slice(prefix.length));
};
const cli = async (...args) =>
  result(
    (await compose(['exec', '-T', 'billing-bridge', 'node', 'dist/cli.js', ...args])).out,
    'billing-result=',
  );
const inner = async (phase) =>
  result(
    (
      await compose([
        'run',
        '--rm',
        '--no-deps',
        '-e',
        'ADMIN_DATABASE_URL',
        '-e',
        'KATIP_BILLING_DB_PASSWORD',
        '-v',
        `${join(ROOT, 'scripts', 'setup', 'lago-check-inner.mjs')}:/app/billing-bridge/lago-check-inner.mjs:ro`,
        'billing-bridge',
        'node',
        'lago-check-inner.mjs',
        phase,
      ])
    ).out,
    'check-result=',
  );
/** A run, again if the service's own hourly run held the lock. */
const runNow = async () => {
  for (let i = 0; i < 10; i++) {
    const r = await cli('run');
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error('billing-bridge never got the run lock');
};

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
const sec = (ms) => `${(ms / 1000).toFixed(0)}s`;

try {
  console.log(`building ${image}`);
  await tryRun(
    'docker',
    ['build', '-q', '-t', image, '-f', 'apps/billing-bridge/Dockerfile', '.'],
    {
      timeoutMs: 900_000,
    },
  );

  const t0 = Date.now();
  await compose(['up', '-d', '--wait', ...LAGO, 'postgres']);
  const lagoStart = Date.now() - t0;
  console.log(`Lago healthy after ${sec(lagoStart)}, from empty volumes`);

  await inner('prepare');
  await compose(['up', '-d', '--wait', 'billing-bridge']);

  // P1-36: the catalog, once.
  const first = await cli('setup');
  check(first.created.length === 7, `setup created ${first.created.join(', ')}`);
  const second = await cli('setup');
  check(
    second.created.length === 0,
    'setup a second time creates nothing, and finds no difference',
  );

  // The test customers and their subscriptions, from three hours back so usage is in them.
  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const since = new Date(
    Math.max(monthStart, Math.floor(now / 3_600_000) * 3_600_000 - 3 * 3_600_000),
  );
  for (const slug of ['demo', 'acme']) {
    const r = await cli(
      'attach',
      '--slug',
      slug,
      '--email',
      `billing@${slug}.test`,
      '--since',
      since.toISOString(),
    );
    const again = await cli('attach', '--slug', slug, '--since', since.toISOString());
    check(
      r.subscription === `${slug}-monthly` && again.subscription === r.subscription,
      `test customer ${slug} and subscription ${r.subscription}, the same when asked again`,
    );
  }

  // Usage in.
  const firstRun = await runNow();
  check(firstRun.errors.length === 0, `first run: ${JSON.stringify(firstRun.tenants)}`);
  const lago1 = await inner('lago');
  // From prepare: demo 400k+100k + 20k+5k (tr is standard) + 250k+250k, premium 30k+10k.
  const demoStd = 1_025_000;
  check(
    lago1.demo.standard_tokens?.[0] === demoStd,
    `Lago counts ${lago1.demo.standard_tokens?.[0]} standard overage tokens for demo, wanted ${demoStd}`,
  );
  check(
    lago1.demo.premium_tokens?.[0] === 40_000,
    `Lago counts ${lago1.demo.premium_tokens?.[0]} premium tokens for demo, wanted 40000`,
  );
  check(
    lago1.demo.seats_business?.[0] === 10,
    `Lago counts ${lago1.demo.seats_business?.[0]} business seats for demo`,
  );
  check(
    lago1.acme.seats_starter?.[0] === 5 && lago1.acme.kvkk_seats?.[0] === 5,
    'acme: 5 starter seats, and the KVKK add-on on each',
  );
  check(lago1.acme.premium_tokens?.[0] === 1_234, 'acme: its premium overage');
  // $1/1M standard and $6/1M premium: 102.5 and 24 cents, as Lago rounds them.
  console.log(`Lago's amounts for demo: ${JSON.stringify(lago1.demo)}`);
  const rec1 = await cli('reconcile');
  check(
    rec1.reports.length === 2 && rec1.reports.every((r) => r.ok),
    `reconcile: ${JSON.stringify(rec1.reports.map((r) => r.classes))}`,
  );

  // A replay of every event.
  const replay = await inner('replay');
  const replayRun = await runNow();
  const lago2 = await inner('lago');
  check(
    replayRun.errors.length === 0 && JSON.stringify(lago2) === JSON.stringify(lago1),
    `a replay of all ${replay.usage + replay.seats} events changed nothing Lago bills`,
  );

  // Usage arriving late for an hour already sent.
  const late = await inner('late');
  await runNow();
  const lago3 = await inner('lago');
  check(
    lago3.demo.standard_tokens?.[0] === demoStd + late.added,
    `late usage billed once: ${lago3.demo.standard_tokens?.[0]}`,
  );
  const sent = await inner('sent');
  const lateRows = sent.usage.filter((r) => /-standard-1$/.test(r.transaction_id));
  check(
    lateRows.length === 1 && Number(lateRows[0].tokens) === late.added,
    `late usage went as ${lateRows.map((r) => r.transaction_id).join(', ')}`,
  );

  // A seat change.
  await inner('seats');
  await runNow();
  const lago4 = await inner('lago');
  check(
    lago4.demo.seats_business?.[0] === 12,
    `seats after the change: ${lago4.demo.seats_business?.[0]}`,
  );
  const rec2 = await cli('reconcile');
  check(
    rec2.reports.every((r) => r.ok),
    'reconcile still matches after the replay, the late usage and the seats',
  );

  // Memory, once Lago has had a minute with nothing to do.
  await new Promise((res) => setTimeout(res, 60_000));
  const stats = await tryRun('docker', [
    'stats',
    '--no-stream',
    '--format',
    '{{.Name}} {{.MemUsage}}',
    ...[...LAGO, 'billing-bridge'].map((s) => `${project}-${s}-1`),
  ]);
  console.log(`memory, idle:\n${stats.out.trim()}`);
  console.log(`Lago start from empty: ${sec(lagoStart)}`);
} catch (e) {
  failures.push(e.message);
  console.error(e.message);
  const logs = await run('docker', [
    'compose',
    '-p',
    project,
    'logs',
    '--tail',
    '40',
    'billing-bridge',
    'lago-api',
  ]);
  console.error(logs.out.slice(-4000));
} finally {
  await run(
    'docker',
    [
      'compose',
      '--env-file',
      envFile,
      '-p',
      project,
      '-f',
      'infra/compose/billing.yml',
      '-f',
      overlay,
      'down',
      '-v',
      '--remove-orphans',
    ],
    { env },
  );
  await run('docker', ['image', 'rm', image]);
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nLago check passed');
