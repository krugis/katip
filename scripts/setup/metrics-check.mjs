#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:metrics: real chats through the running dev stack, then a real Prometheus scraping
 * the gateway and answering every query the dashboard uses (tracker P1-15). The Prometheus
 * here lasts as long as this test: running one for good is P1-43.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig } from './config.mjs';
import { AUTO_KEYS, deriveEnv, loadAllTenantSecrets, tenantSecretOf } from './steps.mjs';
import { ensureEnvFile, INFRA, ROOT } from './util.mjs';

const PROMETHEUS = 'prom/prometheus:v3.5.0';
const config = loadConfig();
const project = config.project.name;
const ctx = { config, infra: INFRA, env: ensureEnvFile(AUTO_KEYS, deriveEnv).env, log: () => {} };
loadAllTenantSecrets(ctx);
const tenant = config.tenants[0];
const key = tenantSecretOf(ctx, tenant, 'GATEWAY_KEY');
const USER = 'demo@example.com';
const SECRET_WORD = 'GizliKelime73';
const gatewayContainer = `${project}-policy-gateway-1`;
const prometheus = `${project}-metrics-check-${process.pid}`;

let checks = 0;
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks += 1;
  console.log(`  ok  ${what}`);
};
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** From inside the backend network, as a company's LibreChat reaches the gateway. */
const chat = (stream) => {
  const script = `
    const r = await fetch('http://policy-gateway:8080/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.K, 'x-user-email': process.env.E, 'content-type': 'application/json' },
      body: process.env.B,
    });
    await r.text();
    console.log(r.status);`;
  const body = JSON.stringify({
    model: 'fast',
    stream,
    max_tokens: 8,
    messages: [{ role: 'user', content: `${SECRET_WORD} 10000000146` }],
  });
  return docker(
    'exec',
    '-e',
    `K=${key}`,
    '-e',
    `E=${USER}`,
    '-e',
    `B=${body}`,
    `${project}-console-api-1`,
    'node',
    '--input-type=module',
    '-e',
    script,
  );
};

/** The token stays inside the container, so it can't appear in a failure message. */
const scrape = () =>
  docker(
    'exec',
    gatewayContainer,
    'sh',
    '-c',
    'wget -qO- --header="Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:9464/metrics',
  );

/** What a company's LibreChat gets when it tries, reachable or not. */
const fromTenant = (url) =>
  docker(
    'exec',
    `${project}-${tenant.slug}-lc-${tenant.slug}-1`,
    'node',
    '-e',
    `fetch(${JSON.stringify(url)}).then((r) => console.log(r.status), () => console.log('unreachable'))`,
  );

const dir = mkdtempSync(join(tmpdir(), 'katip-metrics-'));
try {
  console.log('the numbers');
  check(chat(false) === '200', 'a chat goes through');
  check(chat(true) === '200', 'and a streamed one');
  const out = scrape();
  const series = (name) => out.split('\n').filter((l) => l.startsWith(name));
  check(
    series('gw_requests_total').some((l) => l.includes(`tenant="${tenant.slug}"`)),
    'requests are counted by company',
  );
  check(
    series('gw_tokens_total').some((l) => l.includes(`tenant="${tenant.slug}"`)),
    'and tokens',
  );
  check(series('gw_upstream_latency_seconds_bucket').length > 0, 'and how long models take');
  check(series('gw_overhead_seconds_bucket').length > 0, 'and what the gateway adds');
  check(series('gw_pii_entities_total{type="TR_TCKN"}').length === 1, 'and what was masked');
  check(series('process_cpu_seconds_total').length === 1, 'and the process itself');
  check(!out.includes(SECRET_WORD), 'with no prompt text');
  check(!out.includes('10000000146') && !out.includes(USER), 'and no personal data');

  console.log('who can read them');
  check(fromTenant('http://policy-gateway:9464/metrics') === '401', "a company's LibreChat can't");
  check(
    fromTenant('http://policy-gateway:8080/metrics') === '404',
    "and they aren't on the port it uses",
  );

  console.log('a real Prometheus, and the dashboard');
  const tokenFile = join(dir, 'token');
  writeFileSync(
    join(dir, 'prometheus.yml'),
    `global:
  scrape_interval: 2s
scrape_configs:
  - job_name: gateway
    authorization:
      credentials_file: /cfg/token
    static_configs:
      - targets: ['policy-gateway:9464']
`,
  );
  writeFileSync(
    tokenFile,
    docker('exec', gatewayContainer, 'sh', '-c', 'printf %s "$METRICS_TOKEN"'),
    { mode: 0o600 },
  );
  // Its own user, so a token only this user can read still works.
  chmodSync(dir, 0o700);
  docker(
    'run',
    '-d',
    '--name',
    prometheus,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    '--network',
    `${project}_backend`,
    '-v',
    `${dir}:/cfg:ro`,
    PROMETHEUS,
    '--config.file=/cfg/prometheus.yml',
    '--storage.tsdb.path=/tmp/tsdb',
  );
  const query = (expr) => {
    const url = `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent(expr)}`;
    return JSON.parse(docker('exec', prometheus, 'wget', '-qO-', url)).data.result;
  };
  let up = false;
  for (let i = 0; i < 30 && !up; i += 1) {
    await sleep(1000);
    try {
      up = query('up{job="gateway"}')[0]?.value[1] === '1';
    } catch {
      up = false;
    }
  }
  check(up, 'it scrapes the gateway with the token');
  for (let i = 0; i < 4; i += 1) {
    chat(i % 2 === 0);
    await sleep(2500);
  }

  const dashboard = JSON.parse(
    readFileSync(join(ROOT, 'infra/monitoring/grafana/dashboards/gateway.json'), 'utf8'),
  );
  // Nothing has gone wrong in this test, so these have nothing to show.
  const onlyWhenSomethingFails = new Set([
    'Errors by company',
    'Upstream errors by model',
    'Quota denials',
    'Name check failures',
  ]);
  for (const panel of dashboard.panels) {
    const title = panel.title;
    for (const target of panel.targets) {
      const result = query(target.expr);
      if (onlyWhenSomethingFails.has(title)) {
        check(Array.isArray(result), `"${title}" is a valid query`);
      } else if (target.expr.includes('by (tenant')) {
        check(
          result.some((s) => s.metric.tenant === tenant.slug),
          `"${title}" shows ${tenant.slug}`,
        );
      } else {
        check(result.length > 0, `"${title}" has data`);
      }
    }
  }
  check(dashboard.panels.length >= 6, 'the dashboard has requests, tokens and latency');
  console.log(`\nAll ${checks} checks passed.`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
} finally {
  try {
    docker('rm', '-f', prometheus);
  } catch {
    // It never started.
  }
  rmSync(dir, { recursive: true, force: true });
}
