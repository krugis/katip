// SPDX-License-Identifier: AGPL-3.0-only
// Monitoring (P1-43): what's installed, where it can be reached, what it collects. The rules'
// own tests run in promtool: pnpm test:alert-rules. The running stack: pnpm test:monitoring.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeEnv,
  loadConfig,
  monitoringEnabled,
  MONITORING_IMAGES,
  validateConfig,
} from '../config.mjs';
import { DEPLOY_UP_FLAGS } from '../deploy-lib.mjs';
import { MONITORING_HOST_PORTS, MONITORING_NETWORKS } from '../isolation.mjs';
import { platformSecretNames } from '../secret-rotation.mjs';
import {
  AUTO_KEYS,
  containerInventoryText,
  LOGGED_SERVICES,
  MONITORING_SERVICES,
  platformComposeArgs,
  SERVICE_STEPS,
  steps,
} from '../steps.mjs';
import { INFRA, parseEnvFile } from '../util.mjs';

const config = loadConfig();
const clone = () => structuredClone(config);
const read = (...p) => readFileSync(join(INFRA, ...p), 'utf8');
const compose = () => read('compose', 'monitoring.yml');

/** The text of one service's block in monitoring.yml. */
const block = (name) => {
  const text = compose();
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const end = rest.slice(1).search(/\n {2}[a-z-]+:\n|\nnetworks:/);
  return rest.slice(0, end + 1);
};

describe('monitoring config', () => {
  it('is on in the checked-in config, with every image pinned', () => {
    expect(monitoringEnabled(config)).toBe(true);
    expect(validateConfig(config)).toEqual([]);
    for (const k of MONITORING_IMAGES) {
      expect(config.monitoring.images[k], k).toMatch(/:[\w.-]+$/);
      expect(config.monitoring.images[k], k).not.toMatch(/:latest$/);
    }
  });

  it('is off with no section, which is allowed', () => {
    const c = clone();
    delete c.monitoring;
    expect(validateConfig(c)).toEqual([]);
    expect(monitoringEnabled(c)).toBe(false);
    expect(platformComposeArgs(c)).not.toContain('infra/compose/monitoring.yml');
    expect(platformComposeArgs(config)).toContain('infra/compose/monitoring.yml');
    c.monitoring = { ...config.monitoring, enabled: false };
    expect(platformComposeArgs(c)).not.toContain('infra/compose/monitoring.yml');
  });

  it('rejects what it should', () => {
    const c = clone();
    c.monitoring.images.grafana = 'grafana/grafana:latest';
    c.monitoring.images.loki = 'grafana/loki';
    c.monitoring.metrics_retention_days = 7;
    c.monitoring.logs_retention_days = 90;
    c.monitoring.alert_email = 'not an address';
    c.monitoring.telegram = 'x';
    c.monitoring.enabled = 'yes';
    expect(validateConfig(c)).toEqual(
      expect.arrayContaining([
        'monitoring.images.grafana: :latest is not allowed',
        'monitoring.images.loki: must be a pinned image reference (name:tag)',
        'monitoring.metrics_retention_days: must be a whole number of days, 8 to 400',
        'monitoring.logs_retention_days: must be a whole number of days, 1 to 30',
        'monitoring.alert_email: must be an email address',
        'monitoring.telegram: unknown setting',
        'monitoring.enabled: must be true or false',
      ]),
    );
  });

  it('passes images and retention to compose', () => {
    const env = composeEnv(config);
    expect(env.KATIP_IMAGE_GRAFANA).toBe(config.monitoring.images.grafana);
    expect(env.KATIP_IMAGE_VALKEY_EXPORTER).toBe(config.monitoring.images.valkey_exporter);
    expect(env.KATIP_MONITORING_METRICS_RETENTION).toBe('15d');
    expect(env.KATIP_MONITORING_LOGS_RETENTION).toBe('168h');
    for (const k of MONITORING_IMAGES) {
      expect(compose(), k).toContain(`\${KATIP_IMAGE_${k.toUpperCase()}:?`);
    }
  });

  it('generates its secrets once, and knows how each one is rotated', () => {
    const example = parseEnvFile(read('env', 'katip.example.env'));
    for (const k of [
      'GRAFANA_ADMIN_PASSWORD',
      'KATIP_MONITOR_DB_PASSWORD',
      'KATIP_MONITOR_MONGO_PASSWORD',
      'KATIP_MONITOR_VALKEY_PASSWORD',
    ]) {
      expect(AUTO_KEYS.has(k), k).toBe(true);
      expect(example[k], k).toBe('AUTO');
      expect(platformSecretNames(), k).toContain(k);
    }
  });

  it('is installed by the one script, before the isolation checks', () => {
    const ids = steps.map((s) => s.id);
    expect(ids.indexOf('monitoring')).toBe(ids.indexOf('isolation') - 1);
    expect(SERVICE_STEPS).toContain('monitoring');
    expect(DEPLOY_UP_FLAGS[0]).toContain(',monitoring,');
    expect(
      readFileSync(join(INFRA, '..', 'scripts', 'setup', 'deploy-lib.mjs'), 'utf8').match(
        /,monitoring,isolation/g,
      ),
    ).toHaveLength(2);
  });
});

describe('who can reach it', () => {
  it('publishes Grafana, Prometheus and the log input on 127.0.0.1 only', () => {
    const ports = [...compose().matchAll(/^\s+- '([^']+:\d+)'$/gm)].map((m) => m[1]);
    expect(ports.sort()).toEqual([
      '127.0.0.1:24224:24224',
      '127.0.0.1:3000:3000',
      '127.0.0.1:9090:9090',
    ]);
    expect(Object.values(MONITORING_HOST_PORTS).sort((a, b) => a - b)).toEqual([3000, 9090, 24224]);
  });

  it('joins no company network, and only the networks isolation.mjs allows', () => {
    expect(Object.keys(MONITORING_NETWORKS).sort()).toEqual([...MONITORING_SERVICES].sort());
    for (const [service, nets] of Object.entries(MONITORING_NETWORKS)) {
      const listed = [...block(service).matchAll(/^ {6}- (backend|edge|monitoring)$/gm)].map(
        (m) => m[1],
      );
      expect(listed.sort(), service).toEqual([...nets].sort());
    }
    expect(compose()).not.toMatch(/_t_|tenant/);
  });

  it('gives no container the Docker socket, Docker data or the host root', () => {
    const text = compose();
    expect(text).not.toContain('docker.sock');
    expect(text).not.toMatch(/^\s+- \/var\/run/m);
    expect(text).not.toMatch(/^\s+- \/var\/lib\/docker/m);
    expect(text).not.toMatch(/^\s+- \/:/m);
    // cAdvisor reads cgroups in /sys only.
    expect([...text.matchAll(/^\s+- (\/[^:\s]*):/gm)].map((m) => m[1]).sort()).toEqual([
      '/run/katip',
      '/sys',
      '/sys/fs/cgroup',
    ]);
  });

  it('has no Traefik route', () => {
    for (const f of readdirSync(join(INFRA, 'traefik', 'dynamic'))) {
      expect(read('traefik', 'dynamic', f), f).not.toMatch(/grafana|prometheus|loki|alertmanager/);
    }
  });

  it('scrapes the gateway and console-api with the token, from a file', () => {
    const prom = read('monitoring', 'prometheus', 'prometheus.yml');
    expect(prom.match(/credentials_file: \/run\/katip\/metrics-token/g)).toHaveLength(2);
    expect(block('prometheus')).toContain('/run/katip:uid=65534,gid=65534,mode=0700');
    expect(read('compose', 'dev.yml')).toContain('METRICS_TOKEN: ${KATIP_METRICS_TOKEN');
  });

  it("gives the exporters roles that can't read data", () => {
    expect(block('postgres-exporter')).toContain('DATA_SOURCE_USER: katip_monitor');
    expect(block('mongodb-exporter')).toContain('mongodb://katip_monitor:');
    expect(block('valkey-exporter')).toContain('REDIS_USER: katip-monitor');
    const valkey = read('compose', 'platform.yml');
    expect(valkey).toContain("'-@all'");
    expect(valkey).not.toMatch(/'\+config|'\+get'|'\+@read'/);
  });
});

describe('logs', () => {
  it('ships only our own services, in compose and in the filter', () => {
    const tags = [...compose().matchAll(/^ {8}tag: ([\w-]+)$/gm)].map((m) => m[1]);
    expect(tags.sort()).toEqual([...LOGGED_SERVICES].sort());
    const lua = read('monitoring', 'fluent-bit', 'redact.lua');
    const allowed = [...lua.matchAll(/\['([\w-]+)'\] = true/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual([...LOGGED_SERVICES].sort());
    for (const s of ['librechat', 'rag', 'keycloak', 'lago', 'litellm', 'presidio', 'traefik']) {
      expect(LOGGED_SERVICES.join(), s).not.toContain(s);
    }
  });

  it('keeps logs for the configured days, and deletes them', () => {
    const loki = read('monitoring', 'loki', 'loki.yml');
    expect(loki).toContain('retention_period: ${KATIP_LOGS_RETENTION}');
    expect(loki).toContain('retention_enabled: true');
    expect(loki).toMatch(/analytics:\s+reporting_enabled: false/);
  });
});

describe('alerts', () => {
  const rules = () => read('monitoring', 'prometheus', 'rules', 'katip.yml');
  const inactive = () => read('monitoring', 'prometheus', 'inactive', 'backups.yml');
  const names = (text) => [...text.matchAll(/^\s+- alert: (\w+)/gm)].map((m) => m[1]);

  it('covers LLD-10 §5 and the tracker', () => {
    expect(names(rules())).toEqual(
      expect.arrayContaining([
        'ScrapeTargetDown',
        'ContainerDown',
        'DiskAlmostFull',
        'TlsCertificateExpiresSoon',
        'GatewayErrorRateHigh',
        'UpstreamErrorRateHigh',
        'GatewayOverheadP95High',
        'UpstreamLatencyP95High',
        'ValkeyMemoryHigh',
        'FailedLoginSpike',
        'BudgetAnomaly',
        'ProvisionerJobFailed',
        'DailyJobFailed',
        'DailyJobLate',
        'PiiDetectorFailed',
        'PiiNamesSentUnchecked',
      ]),
    );
    expect(names(inactive())).toEqual(['BackupMissing', 'RestoreTestFailed', 'RestoreTestMissing']);
  });

  it('has a promtool test for every alert, the inactive ones included', () => {
    const tests = read('monitoring', 'prometheus', 'tests', 'katip.test.yml');
    for (const n of [...names(rules()), ...names(inactive())]) {
      expect(tests, n).toContain(`alertname: ${n}`);
    }
  });

  it("doesn't load the backup rules until P1-42 writes what they read", () => {
    expect(read('monitoring', 'prometheus', 'prometheus.yml')).toContain(
      '/etc/prometheus/rules/*.yml',
    );
    expect(inactive()).toContain('INACTIVE');
  });

  it('emails through Mailpit only, and leaves the real channel empty', () => {
    const am = read('monitoring', 'alertmanager', 'alertmanager.tmpl.yml');
    expect(am).toContain("smtp_smarthost: 'mailpit:1025'");
    expect(am.match(/smarthost:/g)).toHaveLength(1);
    const owner = am.slice(am.indexOf('  - name: owner-channel'));
    expect(owner).not.toMatch(/_configs:/);
    expect(am).not.toMatch(/telegram_configs:|webhook_configs:|pagerduty_configs:/);
  });
});

describe('dashboards', () => {
  const dir = join(INFRA, 'monitoring', 'grafana', 'dashboards');
  const load = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

  it('has the gateway, the platform and one company', () => {
    expect(
      readdirSync(dir)
        .map((f) => load(f).uid)
        .sort(),
    ).toEqual(['katip-company', 'katip-gateway', 'katip-platform']);
  });

  it('shows cost on the provider-only platform dashboard alone', () => {
    for (const f of readdirSync(dir)) {
      const d = load(f);
      const withCost = d.panels.filter((p) => p.targets.some((t) => t.expr.includes('cost')));
      if (d.uid === 'katip-platform') {
        expect(withCost.map((p) => p.title)).toEqual([
          'Spend by company, 24 h (list price, provider only)',
        ]);
      } else {
        expect(withCost, f).toEqual([]);
      }
    }
  });
});

describe('container names for cAdvisor', () => {
  it('lists only this install, with ids cAdvisor can match', () => {
    const id = (c) => c.repeat(64);
    const ps = [
      `${id('a')}\tkatip-policy-gateway-1\tkatip\tpolicy-gateway`,
      `${id('b')}\tkatip-demo-lc-demo-1\tkatip-demo\tlc-demo`,
      `${id('c')}\tsomething-else\tother\tx`,
      `short\tbroken\tkatip\tx`,
      `${id('d')}\tkatip-tool-1\t\t`,
    ].join('\n');
    const text = containerInventoryText(ps, 'katip');
    expect(text).toContain(
      `katip_container_info{container_id="${id('a')}",name="katip-policy-gateway-1",project="katip",service="policy-gateway"} 1`,
    );
    expect(text).toContain('name="katip-demo-lc-demo-1",project="katip-demo"');
    expect(text).not.toContain('something-else');
    expect(text).not.toContain('broken');
    expect(text).not.toContain('katip-tool-1');
  });
});
