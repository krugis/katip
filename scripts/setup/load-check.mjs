#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:load: 50 streaming chats at once through a real gateway, against a mock provider
 * whose answers take about as long as a real model's (tracker P1-16, LLD-03 §8). Chats start
 * spread out over one answer's length, then each sends its next message when it finishes. Its own gateway, mock and analyzer on the running dev
 * stack's network, so a local model in katip.env doesn't matter, and the analyzer has 2 CPUs
 * like a small server. It uses the first company's real database rows and quota, so that
 * company gets some extra usage. Everything it starts is removed afterwards.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { AUTO_KEYS, deriveEnv, loadAllTenantSecrets, tenantSecretOf } from './steps.mjs';
import { ensureEnvFile, INFRA } from './util.mjs';

const STREAMS = Number(process.env.LOAD_STREAMS ?? 50);
const SECONDS = Number(process.env.LOAD_SECONDS ?? 120);
/** Per chunk. An answer here is about 23 chunks, so the default makes answers of about 17 s. */
const CHUNK_DELAY_MS = Number(process.env.LOAD_CHUNK_DELAY_MS ?? 750);
const ANALYZER_CPUS = Number(process.env.LOAD_ANALYZER_CPUS ?? 2);
const OVERHEAD_P95_LIMIT = 0.12;
const CPU_LIMIT_PERCENT = 100;

const config = loadConfig();
const project = config.project.name;
const network = `${project}_backend`;
const ctx = { config, infra: INFRA, env: ensureEnvFile(AUTO_KEYS, deriveEnv).env, log: () => {} };
loadAllTenantSecrets(ctx);
const tenant = config.tenants[0];
const names = {
  mock: `${project}-load-mock-${process.pid}`,
  analyzer: `${project}-load-analyzer-${process.pid}`,
  gateway: `${project}-load-gateway-${process.pid}`,
};
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), 'katip-load-'));

/** Secrets go in a file only this user can read, so no failure message can quote them. */
const envFile = (name, values) => {
  const path = join(dir, name);
  writeFileSync(
    path,
    `${Object.entries(values)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
    {
      mode: 0o600,
    },
  );
  return path;
};

const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/** The p95 of a Prometheus histogram's growth, read off its buckets. */
function histogramP95(before, after) {
  const buckets = (text) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('gw_overhead_seconds_bucket'))
      .map((l) => ({ le: /le="([^"]+)"/.exec(l)[1], n: Number(l.split(' ').at(-1)) }));
  const old = new Map(buckets(before).map((b) => [b.le, b.n]));
  const grown = buckets(after).map((b) => ({ le: b.le, n: b.n - (old.get(b.le) ?? 0) }));
  const total = grown.find((b) => b.le === '+Inf').n;
  const within = (le) => grown.find((b) => b.le === String(le))?.n / total;
  const p95 = grown.find((b) => b.n >= total * 0.95).le;
  return { total, p95, within120ms: within(OVERHEAD_P95_LIMIT), within40ms: within(0.05) };
}

const CLIENT = `
const end = Date.now() + Number(process.env.SECONDS) * 1000;
const results = [];
const failures = {};
let serial = 0;
const worker = async (w) => {
  await new Promise((r) => setTimeout(r, w * Number(process.env.SPREAD_MS)));
  const history = [
    { role: 'user', content: 'Merhaba, geçen hafta konuştuğumuz satış raporu hazır mı?' },
    { role: 'assistant', content: 'Evet, raporu hazırladım ve ekibe ilettim.' },
  ];
  while (Date.now() < end) {
    const n = (serial += 1);
    const started = performance.now();
    const content = 'Madde ' + n + ' için Ayşe Yılmaz ile görüştüm, işçi ' + w + ' raporu bekliyor. Toplantıda bütçe ve yeni ürün planı konuşuldu, karar haftaya kaldı.';
    try {
      const r = await fetch('http://' + process.env.GATEWAY + ':8080/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.K, 'x-user-email': process.env.E, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fast', stream: true, max_tokens: 64, messages: [...history, { role: 'user', content }] }),
      });
      let first = null;
      for await (const _ of r.body) if (first === null) first = performance.now();
      if (r.status === 200) results.push({ ttfb: first - started, total: performance.now() - started });
      else failures[r.status] = (failures[r.status] ?? 0) + 1;
    } catch (e) {
      failures[e.name] = (failures[e.name] ?? 0) + 1;
    }
  }
};
await Promise.all(Array.from({ length: Number(process.env.STREAMS) }, (_, w) => worker(w)));
console.log(JSON.stringify({ results, failures }));
`;

const started = [];
const run = (name, ...args) => {
  docker('run', '-d', '--name', name, '--network', network, ...args);
  started.push(name);
};

let failed = false;
try {
  const presidio = config.images.presidio_analyzer;
  run(
    names.mock,
    '-e',
    'PORT=8080',
    '-e',
    `MOCK_DELAY_MS=${CHUNK_DELAY_MS}`,
    'ghcr.io/krugis/mock-llm:dev',
  );
  run(
    names.analyzer,
    `--cpus=${ANALYZER_CPUS}`,
    '-e',
    'PORT=3000',
    '-e',
    'WORKERS=2',
    '-e',
    'OMP_NUM_THREADS=2',
    `ghcr.io/krugis/presidio-analyzer:${presidio.version}`,
  );
  const e = ctx.env;
  run(
    names.gateway,
    '--env-file',
    envFile('gateway.env', {
      PORT: '8080',
      LITELLM_BASE_URL: `http://${names.mock}:8080/v1`,
      LITELLM_API_KEY: 'load-test',
      DATABASE_URL: `postgres://katip_gateway:${e.KATIP_GATEWAY_DB_PASSWORD}@postgres:5432/governance`,
      VALKEY_URL: `redis://:${e.VALKEY_PASSWORD}@valkey:6379`,
      PRESIDIO_URL: `http://${names.analyzer}:3000`,
      PII_TOKEN_KEY: e.KATIP_PII_TOKEN_KEY,
      METRICS_TOKEN: e.KATIP_METRICS_TOKEN,
      LOG_LEVEL: 'warn',
    }),
    'ghcr.io/krugis/policy-gateway:dev',
  );
  const scrape = () =>
    docker(
      'exec',
      names.gateway,
      'sh',
      '-c',
      'wget -qO- --header="Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics',
    );
  let up = false;
  for (let i = 0; i < 90 && !up; i += 1) {
    await sleep(2000);
    try {
      const ready = docker(
        'exec',
        names.gateway,
        'sh',
        '-c',
        `wget -qO- http://127.0.0.1:8080/readyz && wget -qO- http://${names.analyzer}:3000/health`,
      );
      up = ready.length > 0;
    } catch {
      up = false;
    }
  }
  if (!up) throw new Error('the load stack did not start');

  const clientEnv = envFile('client.env', {
    K: tenantSecretOf(ctx, tenant, 'GATEWAY_KEY'),
    E: 'demo@example.com',
    GATEWAY: names.gateway,
    STREAMS: String(STREAMS),
    SECONDS: String(SECONDS),
    SPREAD_MS: String(Math.round((CHUNK_DELAY_MS * 23) / STREAMS)),
  });
  const runClient = () =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          network,
          '--env-file',
          clientEnv,
          'ghcr.io/krugis/policy-gateway:dev',
          'node',
          '--input-type=module',
          '-e',
          CLIENT,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
      );
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('exit', (code) =>
        code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`load client exit ${code}`)),
      );
    });

  console.log(`${STREAMS} streams for ${SECONDS} s, on the running stack's database`);
  const before = scrape();
  const client = runClient();
  const cpu = { gateway: [], analyzer: [] };
  let finished = false;
  void client.finally(() => (finished = true));
  const memory = {};
  // After the ramp, so it measures streams running rather than starting.
  await sleep(8000);
  while (!finished) {
    // docker() blocks, so without this the client finishing would never be noticed.
    await sleep(200);
    const stats = docker(
      'stats',
      '--no-stream',
      '--format',
      '{{.Name}} {{.CPUPerc}} {{.MemUsage}}',
      names.gateway,
      names.analyzer,
    );
    for (const line of stats.split('\n')) {
      const [name, percent, used] = line.split(' ');
      const which = name === names.gateway ? 'gateway' : 'analyzer';
      cpu[which].push(Number.parseFloat(percent));
      memory[which] = used;
    }
  }
  const { results, failures } = await client;
  const after = scrape();

  const overhead = histogramP95(before, after);
  // A timed-out name check isn't a failed request: by default it goes out with names unmasked.
  const nameCheckFailures = (text) =>
    text
      .split('\n')
      .filter((l) => l.startsWith('gw_pii_detector_failures_total{'))
      .reduce((sum, l) => sum + Number(l.split(' ').at(-1)), 0);
  const unchecked = nameCheckFailures(after) - nameCheckFailures(before);
  const sorted = (key) => results.map((r) => r[key]).sort((a, b) => a - b);
  const ttfb = sorted('ttfb');
  const total = sorted('total');
  const average = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  console.log(
    `  completed: ${results.length}, failures: ${JSON.stringify(failures)}, name checks failed: ${unchecked}`,
  );
  console.log(`  messages per second: ${(results.length / SECONDS).toFixed(1)}`);
  console.log(
    `  gateway overhead: p95 under ${overhead.p95} s; within 120 ms: ${(overhead.within120ms * 100).toFixed(1)}%; within 50 ms: ${(overhead.within40ms * 100).toFixed(1)}%`,
  );
  console.log(
    `  first byte: p50 ${Math.round(percentile(ttfb, 0.5))} ms, p95 ${Math.round(percentile(ttfb, 0.95))} ms`,
  );
  console.log(
    `  whole stream: p50 ${Math.round(percentile(total, 0.5))} ms, p95 ${Math.round(percentile(total, 0.95))} ms`,
  );
  console.log(
    `  gateway CPU: average ${average(cpu.gateway).toFixed(0)}%, peak ${Math.max(...cpu.gateway).toFixed(0)}% of one CPU; memory ${memory.gateway}`,
  );
  console.log(
    `  analyzer CPU: average ${average(cpu.analyzer).toFixed(0)}%, peak ${Math.max(...cpu.analyzer).toFixed(0)}% (limit 200%); memory ${memory.analyzer}`,
  );

  const problems = [];
  if (Object.keys(failures).length > 0) problems.push('some requests failed');
  if (unchecked > 0) problems.push(`${unchecked} requests had no name check`);
  if (overhead.within120ms < 0.95) problems.push('p95 overhead is over 120 ms');
  if (average(cpu.gateway) > CPU_LIMIT_PERCENT) problems.push('the gateway used over 1 CPU');
  if (problems.length > 0) {
    console.error(`\nBelow target: ${problems.join('; ')}.`);
    failed = true;
  } else {
    console.log('\nMeets the targets: p95 overhead under 120 ms, gateway under 1 CPU.');
  }
} catch (e) {
  console.error(`\n${e.message}`);
  failed = true;
} finally {
  for (const name of started) {
    try {
      docker('rm', '-f', name);
    } catch {
      // Already gone.
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
