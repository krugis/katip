#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pnpm test:monitoring (P1-43): checks the monitoring stack of the running dev install.
 *
 *   1. every Prometheus target is up, the jobs prometheus.yml names are all there;
 *   2. every alert rule in infra/monitoring/prometheus/rules is loaded and evaluates cleanly,
 *      and Watchdog has reached Alertmanager, which shows Prometheus → Alertmanager works;
 *   3. an alert put into Alertmanager reaches Mailpit as an email, and is resolved after;
 *   4. Grafana asks for its password, has the three dashboards, and every query on them runs
 *      through its data sources; those that should have data, have it;
 *   5. a chat through the gateway leaves a line in Loki within a minute, with no email address
 *      or IP address in what Loki holds of it;
 *   6. from a company's LibreChat, no monitoring service answers, by name or on the host's ports.
 *
 * Read-only apart from one chat, one test alert (resolved at the end) and one email in Mailpit.
 * KATIP_CHECK_PROJECT, KATIP_CHECK_SKIP=chat,tenant and KATIP_CHECK_MAILPIT let it run against a
 * throwaway copy of the stack with stand-ins for our services.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { loadConfig, monitoringEnabled } from './config.mjs';
import { MONITORING_HOST_PORTS } from './isolation.mjs';
import { AUTO_KEYS, deriveEnv, loadAllTenantSecrets, tenantSecretOf } from './steps.mjs';
import { ensureEnvFile, INFRA } from './util.mjs';

const config = loadConfig();
const stub = Boolean(process.env.KATIP_CHECK_PROJECT);
const project = process.env.KATIP_CHECK_PROJECT ?? config.project.name;
const skip = new Set((process.env.KATIP_CHECK_SKIP ?? '').split(',').filter(Boolean));
const env = stub ? process.env : ensureEnvFile(AUTO_KEYS, deriveEnv).env;
const tenant = config.tenants[0];
const PROMETHEUS = 'http://127.0.0.1:9090';
const GRAFANA = 'http://127.0.0.1:3000';
const MAILPIT = process.env.KATIP_CHECK_MAILPIT ?? 'http://127.0.0.1:8025';

let checks = 0;
const check = (cond, what) => {
  if (!cond) throw new Error(`FAILED: ${what}`);
  checks += 1;
  console.log(`  ok  ${what}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const container = (service) => `${project}-${service}-1`;

async function json(url, init = {}) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

/** Waits for fn to return something truthy, and returns it; null at the end of time. */
async function within(ms, fn, every = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

const grafanaAuth = {
  authorization: `Basic ${Buffer.from(`katip-admin:${env.GRAFANA_ADMIN_PASSWORD}`).toString('base64')}`,
};

/** A query through Grafana's data source, as a dashboard panel runs it. Returns its frames. */
async function grafanaQuery(datasource, expr, minutes = 60) {
  const query = { refId: 'A', datasource, expr, intervalMs: 30_000, maxDataPoints: 200 };
  if (datasource.type === 'loki') query.queryType = 'range';
  const { status, body } = await json(`${GRAFANA}/api/ds/query`, {
    method: 'POST',
    headers: { ...grafanaAuth, 'content-type': 'application/json' },
    body: JSON.stringify({ queries: [query], from: `now-${minutes}m`, to: 'now' }),
  });
  const result = body?.results?.A;
  if (status !== 200 || result?.error) {
    throw new Error(`${expr}: ${status} ${result?.error ?? JSON.stringify(body).slice(0, 200)}`);
  }
  return result.frames ?? [];
}

const hasData = (frames) => frames.some((f) => (f.data?.values?.[0]?.length ?? 0) > 0);

/** Whether a company's LibreChat can open a TCP connection: 'open' or 'closed'. */
const tcpFromTenant = (host, port) =>
  docker(
    'exec',
    `${project}-${tenant.slug}-lc-${tenant.slug}-1`,
    'node',
    '-e',
    `const s = require('net').connect(${Number(port)}, ${JSON.stringify(host)});
     const done = (w) => { console.log(w); s.destroy(); process.exit(0); };
     s.on('connect', () => done('open')); s.on('error', () => done('closed'));
     s.setTimeout(3000, () => done('closed'));`,
  );

/** A chat through the gateway, from inside the platform, as metrics-check.mjs does it. */
function chat() {
  const ctx = { config, infra: INFRA, env, log: () => {} };
  loadAllTenantSecrets(ctx);
  const body = JSON.stringify({
    model: 'fast',
    max_tokens: 8,
    messages: [{ role: 'user', content: 'monitoring check' }],
  });
  return docker(
    'exec',
    '-e',
    `K=${tenantSecretOf(ctx, tenant, 'GATEWAY_KEY')}`,
    '-e',
    `B=${body}`,
    container('console-api'),
    'node',
    '--input-type=module',
    '-e',
    `const r = await fetch('http://policy-gateway:8080/v1/chat/completions', { method: 'POST',
      headers: { authorization: 'Bearer ' + process.env.K, 'x-user-email': 'demo@example.com', 'content-type': 'application/json' },
      body: process.env.B }); await r.text(); console.log(r.status);`,
  );
}

/** Posts to Alertmanager's API from inside Prometheus's container, its only client. */
const alertmanagerPost = (alerts) =>
  docker(
    'exec',
    container('prometheus'),
    'wget',
    '-qO-',
    '--header',
    'content-type: application/json',
    `--post-data=${JSON.stringify(alerts)}`,
    'http://alertmanager:9093/api/v2/alerts',
  );

const alertNames = () => {
  const dir = join(INFRA, 'monitoring', 'prometheus', 'rules');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml'))
    .flatMap((f) => [...readFileSync(join(dir, f), 'utf8').matchAll(/^\s*- alert: (\S+)/gm)])
    .map((m) => m[1]);
};

const scrapeJobs = () =>
  [
    ...readFileSync(join(INFRA, 'monitoring', 'prometheus', 'prometheus.yml'), 'utf8').matchAll(
      /job_name: (\S+)/g,
    ),
  ].map((m) => m[1]);

try {
  if (!stub && !monitoringEnabled(config)) {
    throw new Error('monitoring.enabled is false in katip.config.yaml: nothing to check');
  }

  console.log('Prometheus');
  const targets = await within(120_000, async () => {
    const { body } = await json(`${PROMETHEUS}/api/v1/targets?state=active`);
    const active = body.data.activeTargets;
    return active.length > 0 && active.every((t) => t.health === 'up') ? active : null;
  });
  if (!targets) {
    const { body } = await json(`${PROMETHEUS}/api/v1/targets?state=active`);
    const down = body.data.activeTargets
      .filter((t) => t.health !== 'up')
      .map((t) => `${t.labels.job}: ${t.lastError || t.health}`);
    check(false, `every target is up (down: ${down.join('; ')})`);
  }
  check(true, `every target is up (${targets.length})`);
  const jobs = new Set(targets.map((t) => t.labels.job));
  const missing = scrapeJobs().filter((j) => !jobs.has(j));
  check(missing.length === 0, `every job in prometheus.yml is scraped (missing: ${missing})`);

  const rules = await within(120_000, async () => {
    const { body } = await json(`${PROMETHEUS}/api/v1/rules`);
    const all = body.data.groups.flatMap((g) => g.rules);
    return all.some((r) => r.health === 'unknown') ? null : all;
  });
  check(Boolean(rules), 'every rule has been evaluated');
  const loaded = new Set(rules.filter((r) => r.type === 'alerting').map((r) => r.name));
  const absent = alertNames().filter((n) => !loaded.has(n));
  check(absent.length === 0, `every alert rule is loaded (${loaded.size}; missing: ${absent})`);
  const broken = rules.filter((r) => r.health !== 'ok').map((r) => `${r.name}: ${r.lastError}`);
  check(broken.length === 0, `and evaluates without error (${broken.join('; ')})`);
  const watchdog = await within(90_000, async () => {
    const out = docker(
      'exec',
      container('prometheus'),
      'wget',
      '-qO-',
      'http://alertmanager:9093/api/v2/alerts?filter=alertname%3D%22Watchdog%22',
    );
    return JSON.parse(out).length > 0;
  });
  check(Boolean(watchdog), 'Prometheus sends its alerts to Alertmanager (Watchdog is there)');

  console.log('an alert, by email to Mailpit');
  const id = `check-${randomBytes(6).toString('hex')}`;
  const alert = {
    // `job` is one of Alertmanager's group_by labels: a new value makes a new group, sent after
    // group_wait (30 s), so a second run within group_interval doesn't wait 5 minutes.
    labels: { alertname: 'KatipMonitoringCheck', severity: 'warning', job: id, check_id: id },
    annotations: { summary: 'pnpm test:monitoring: a test alert, resolved at once' },
    startsAt: new Date().toISOString(),
  };
  alertmanagerPost([alert]);
  // group_wait is 30 s.
  const mail = await within(
    120_000,
    async () => {
      const { body } = await json(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(id)}`);
      return body.messages_count > 0 ? body.messages[0] : null;
    },
    5000,
  );
  check(Boolean(mail), 'the alert arrives in Mailpit');
  check(
    mail.To.every((t) => t.Address === config.monitoring.alert_email),
    `addressed to monitoring.alert_email only (${config.monitoring.alert_email})`,
  );
  alertmanagerPost([{ ...alert, endsAt: new Date().toISOString() }]);

  console.log('Grafana');
  const anon = await json(`${GRAFANA}/api/search`);
  check(anon.status === 401, 'asks for a password');
  const { body: found } = await json(`${GRAFANA}/api/search?type=dash-db`, {
    headers: grafanaAuth,
  });
  const uids = found.map((d) => d.uid).sort();
  check(
    ['katip-company', 'katip-gateway', 'katip-platform'].every((u) => uids.includes(u)),
    `has the dashboards (${uids.join(', ')})`,
  );
  if (!skip.has('chat')) {
    for (let i = 0; i < 3; i += 1) check(chat() === '200', 'a chat goes through the gateway');
    // Two scrapes, so rates have something to compare.
    await sleep(65_000);
  }
  for (const uid of ['katip-gateway', 'katip-platform', 'katip-company']) {
    const { body } = await json(`${GRAFANA}/api/dashboards/uid/${uid}`, { headers: grafanaAuth });
    for (const panel of body.dashboard.panels) {
      const mayBeEmpty =
        /^Empty/.test(panel.description ?? '') ||
        [
          'Errors by company',
          'Upstream errors by model',
          'Quota denials',
          'Name check failures',
        ].includes(panel.title);
      for (const target of panel.targets) {
        const datasource = target.datasource ??
          panel.datasource ?? { type: 'prometheus', uid: 'prometheus' };
        const expr = target.expr.replaceAll('$tenant', tenant.slug);
        // An hour, so each point's 5-minute rate has samples behind it on a stack just started.
        const frames = await grafanaQuery(datasource, expr, 60);
        if (mayBeEmpty) check(true, `${uid}: "${panel.title}" runs`);
        else check(hasData(frames), `${uid}: "${panel.title}" runs and has data`);
      }
    }
  }

  console.log('Loki');
  const lines = await within(
    90_000,
    async () => {
      const frames = await grafanaQuery(
        { type: 'loki', uid: 'loki' },
        '{service="policy-gateway"}',
        15,
      );
      const values = frames.flatMap((f) => {
        const field = f.schema?.fields?.findIndex((x) => x.name === 'Line' || x.name === 'line');
        return field >= 0 ? f.data.values[field] : [];
      });
      return values.length > 0 ? values : null;
    },
    5000,
  );
  check(Boolean(lines), `the gateway's log lines reach Loki (${lines?.length ?? 0} in 15 min)`);
  check(!lines.some((l) => /[\w.+-]+@[\w-]+\.[\w.-]+/.test(l)), 'with no email address in them');
  check(!lines.some((l) => /\b\d+\.\d+\.\d+\.\d+\b/.test(l)), 'and no IP address');
  const others = await grafanaQuery(
    { type: 'loki', uid: 'loki' },
    '{job="katip", service!~"policy-gateway|console-api|identity|billing-bridge"}',
    24 * 60,
  );
  check(!hasData(others), "no other container's logs are in Loki");

  if (!skip.has('tenant')) {
    console.log("from a company's LibreChat");
    // Its own gateway answers, so a closed port below means something.
    check(tcpFromTenant('policy-gateway', 8080) === 'open', 'the gateway answers it');
    for (const target of [
      'prometheus:9090',
      'grafana:3000',
      'loki:3100',
      'alertmanager:9093',
      'fluent-bit:24224',
      'cadvisor:8080',
      'node-exporter:9100',
      'blackbox-exporter:9115',
      'postgres-exporter:9187',
      'mongodb-exporter:9216',
      'valkey-exporter:9121',
      'keycloak:9000',
    ]) {
      const [host, port] = target.split(':');
      check(tcpFromTenant(host, port) === 'closed', `${target} doesn't`);
    }
    const lc = `${project}-${tenant.slug}-lc-${tenant.slug}-1`;
    const gw = docker('exec', lc, 'sh', '-c', "ip route | awk '/^default/{print $3}'");
    check(tcpFromTenant(gw, 443) === 'open', `the host (${gw}) answers on 443, published to all`);
    for (const [service, port] of Object.entries(MONITORING_HOST_PORTS)) {
      check(tcpFromTenant(gw, port) === 'closed', `but not on ${service}'s port, ${port}`);
    }
  }
  console.log(`\nAll ${checks} checks passed.`);
} catch (e) {
  console.error(`\n${e.message}`);
  process.exitCode = 1;
}
