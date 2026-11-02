// SPDX-License-Identifier: AGPL-3.0-only
// Bootstrap steps (P0-12…P0-16). Each step: id, title, run(ctx), rollback?(ctx).
// Steps are layers: a step is done only after its health checks pass, so
// completed layers always work standalone after an interrupt.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryRun, STATE_DIR, Interrupted, isInterrupted } from './util.mjs';

export const COMPOSE_PROJECT = 'sme-platform';
export const TENANT_PROJECT = 'sme-demo';

export const AUTO_KEYS = new Set([
  'POSTGRES_PASSWORD',
  'KC_DB_PASSWORD',
  'LITELLM_DB_PASSWORD',
  'KC_BOOTSTRAP_ADMIN_PASSWORD',
  'MONGO_PASSWORD',
  'MEILI_MASTER_KEY',
  'LITELLM_MASTER_KEY',
  'MOCK_LLM_KEY',
  'KATIP_DEMO_GATEWAY_KEY',
  'KATIP_LC_CREDS_KEY',
  'KATIP_LC_CREDS_IV',
  'KATIP_LC_JWT_SECRET',
  'KATIP_LC_JWT_REFRESH_SECRET',
]);

/** Derived (non-secret) values computed from generated secrets. */
export function deriveEnv(out) {
  return {
    LITELLM_DATABASE_URL:
      out.LITELLM_DATABASE_URL && out.LITELLM_DATABASE_URL !== 'AUTO'
        ? out.LITELLM_DATABASE_URL
        : `postgresql://litellm:${out.LITELLM_DB_PASSWORD}@postgres:5432/litellm`,
  };
}

/** Special generators for keys with format constraints (LibreChat creds). */
export function deriveTenantSecrets() {
  const hex = (n) => randomBytes(n).toString('hex').slice(0, 64);
  return {
    KATIP_LC_CREDS_KEY: hex(16), // 32 hex chars
    KATIP_LC_CREDS_IV: hex(16), // 32 hex chars
  };
}

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

const PLATFORM_FILES = ['-f', 'infra/compose/platform.yml', '-f', 'infra/compose/dev.yml'];
/** Env additions compose needs for interpolation (litellm build args come from
 *  katip.config.yaml, not the env file). */
export function composeEnv(config) {
  return {
    KATIP_COMPOSE_PROJECT: COMPOSE_PROJECT,
    ...(config?.images?.litellm
      ? {
          LITELLM_VERSION: config.images.litellm.version,
          LITELLM_SHA256: config.images.litellm.sha256,
        }
      : {}),
  };
}
/** Compose with the katip.env file as the interpolation env-file. */
const platformCompose = (args, env, config) =>
  tryRun('docker', ['compose', '--env-file', 'infra/env/katip.env', ...PLATFORM_FILES, ...args], {
    env: { ...env, ...composeEnv(config) },
  });

const tenantCompose = (args, env, config) =>
  tryRun(
    'docker',
    [
      'compose',
      '--env-file',
      'infra/env/katip.env',
      '-f',
      'infra/compose/tenants/demo.yml',
      '-p',
      TENANT_PROJECT,
      ...args,
    ],
    {
      env: { ...env, ...composeEnv(config) },
    },
  );

export async function dockerRun(args, env = {}) {
  return tryRun('docker', ['run', '--rm', ...args], { env });
}

async function waitUntil(fn, { timeoutMs = 180_000, intervalMs = 3000, onTick } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    if (isInterrupted()) throw new Interrupted();
    try {
      if (await fn()) return;
    } catch (e) {
      if (e.name === 'Interrupted') throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    onTick?.();
  }
  throw new Error(
    `timeout after ${timeoutMs / 1000}s${lastErr ? ` (last: ${lastErr.message})` : ''}`,
  );
}

const curlImage = 'curlimages/curl:8.8.0';
/** Traefik's IP on the edge network (for *.localhost resolution in checks). */
async function traefikEdgeIp() {
  const r = await tryRun(
    'docker',
    [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      `${COMPOSE_PROJECT}-traefik-1`,
    ],
    {},
  );
  return r.out.trim();
}

/** curl from a throwaway container inside the backend network. */
const curlBackend = (path, env, extra = []) =>
  dockerRun(
    [
      '--network',
      `${COMPOSE_PROJECT}_backend`,
      curlImage,
      '-sS',
      '-m',
      '10',
      `http://policy-gateway:8080${path}`,
      ...extra,
    ],
    env,
  ).then((r) => r.out);

/** curl via traefik from the edge network. curl resolves *.localhost to
 * 127.0.0.1 (RFC 6761), so we hit the traefik IP directly with a Host header. */
async function curlEdge(host, path, env, extra = []) {
  const ip = await traefikEdgeIp();
  return dockerRun(
    [
      '--network',
      `${COMPOSE_PROJECT}_edge`,
      curlImage,
      '-sS',
      '-k',
      '-m',
      '10',
      '-H',
      `Host: ${host}`,
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      `https://${ip}${path}`,
      ...extra,
    ],
    env,
  ).then((r) => r.out);
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

function renderLiteLLMConfig(ctx) {
  const lines = [];
  for (const m of ctx.config.models) {
    const realKey = ctx.env[m.api_key_env] || '';
    const useMock = !realKey;
    lines.push(`  - model_name: ${m.alias}`);
    lines.push(`    litellm_params:`);
    if (useMock) {
      lines.push(`      model: openai/${m.litellm_params.model}`);
      lines.push(`      api_base: http://mock-llm:8080/v1`);
      lines.push(`      api_key: os.environ/MOCK_LLM_KEY`);
    } else {
      lines.push(`      model: ${m.litellm_params.model}`);
      lines.push(`      api_key: os.environ/${m.api_key_env}`);
    }
  }
  const tmpl = readFileSync(join(ctx.infra, 'litellm', 'config.dev.tmpl.yaml'), 'utf8');
  const out = tmpl.replace('%%MODELS%%', lines.join('\n'));
  mkdirSync(join(ctx.infra, 'litellm', 'rendered'), { recursive: true });
  writeFileSync(join(ctx.infra, 'litellm', 'rendered', 'config.dev.yaml'), out);
}

function renderTenantFiles(ctx) {
  const slug = ctx.config.tenant.slug;
  const envDir = join(ctx.infra, 'env', 'tenants');
  mkdirSync(envDir, { recursive: true });

  // tenant env (LC secrets: ensure present in katip.env first)
  const lcSec = deriveTenantSecrets();
  for (const [k, v] of Object.entries(lcSec)) {
    if (!ctx.env[k] || ctx.env[k] === 'AUTO') ctx.env[k] = v;
  }
  const tmplEnv = readFileSync(join(envDir, 'demo.example.env'), 'utf8');
  const envContent = tmplEnv
    .replace(/\$\{KATIP_MONGO_PASSWORD\}/g, ctx.env.MONGO_PASSWORD)
    .replace(/\$\{KATIP_MEILI_MASTER_KEY\}/g, ctx.env.MEILI_MASTER_KEY)
    .replace(/\$\{KATIP_LC_CREDS_KEY\}/g, ctx.env.KATIP_LC_CREDS_KEY)
    .replace(/\$\{KATIP_LC_CREDS_IV\}/g, ctx.env.KATIP_LC_CREDS_IV)
    .replace(/\$\{KATIP_LC_JWT_SECRET\}/g, ctx.env.KATIP_LC_JWT_SECRET)
    .replace(/\$\{KATIP_LC_JWT_REFRESH_SECRET\}/g, ctx.env.KATIP_LC_JWT_REFRESH_SECRET);
  writeFileSync(join(envDir, 'demo.env'), envContent, { mode: 0o600 });
  chmodSync(join(envDir, 'demo.env'), 0o600);

  // librechat.yaml
  const tmplLc = readFileSync(join(ctx.infra, 'librechat', 'librechat.tmpl.yaml'), 'utf8');
  const lc = tmplLc
    .replace(/\$\{KATIP_DEMO_GATEWAY_KEY\}/g, ctx.env.KATIP_DEMO_GATEWAY_KEY)
    .replace(/<slug>/g, slug);
  const lcDir = join(ctx.infra, 'librechat', 'rendered');
  mkdirSync(lcDir, { recursive: true });
  writeFileSync(join(lcDir, `${slug}.librechat.yaml`), lc, { mode: 0o600 });

  // tenant compose file
  const tmplCompose = readFileSync(join(ctx.infra, 'compose', 'tenant.tmpl.yml'), 'utf8');
  const comp = tmplCompose
    .replace(/\$\{KATIP_SLUG\}/g, slug)
    .replace(/\$\{KATIP_BASE_DOMAIN\}/g, ctx.config.project.base_domain)
    .replace(/\$\{KATIP_LIBRECHAT_VERSION\}/g, ctx.config.images.librechat.split(':')[1])
    .replace(/\$\{KATIP_COMPOSE_PROJECT\}/g, COMPOSE_PROJECT);
  const tDir = join(ctx.infra, 'compose', 'tenants');
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, `${slug}.yml`), comp);
}

function renderGatewayTenants(ctx) {
  const t = ctx.config.tenant;
  const gw = {
    tenants: [
      {
        id: '00000000-0000-7000-8000-000000000001',
        slug: t.slug,
        status: 'active',
        apiKeySha256: [sha256hex(ctx.env.KATIP_DEMO_GATEWAY_KEY)],
        kvkkAddon: t.kvkk_addon,
        limits: t.limits,
        policy: { atQuotaLimit: 'downgrade' },
        pii: { mode: t.pii.mode },
        users: [
          {
            id: '00000000-0000-7000-8000-000000000101',
            email: 'demo@example.com',
            status: 'active',
          },
        ],
      },
    ],
  };
  const dir = join(STATE_DIR, 'gateway');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'dev-tenants.json'), JSON.stringify(gw, null, 2));
}

function renderAll(ctx) {
  renderLiteLLMConfig(ctx);
  renderTenantFiles(ctx);
  renderGatewayTenants(ctx);
}

// ---------------------------------------------------------------------------
// steps
// ---------------------------------------------------------------------------

export const steps = [
  {
    id: 'preflight',
    title: 'Preflight (docker, disk, ports)',
    async run(ctx) {
      await tryRun('docker', ['version', '--format', '{{.Server.Version}}'], {});
      await tryRun('docker', ['compose', 'version'], {});
      const df = await tryRun('df', ['-m', '.'], {});
      const avail = parseInt(df.out.split('\n')[1]?.trim().split(/\s+/)[3] ?? '0', 10);
      if (avail < 5000) throw new Error(`only ${avail} MB free on this filesystem (need ≥ 5000)`);
      // ports 80/443 must be free (traefik publishes them)
      const ss = await tryRun('ss', ['-ltn'], {}).catch(() => null);
      if (ss) {
        const bad = ss.out.split('\n').filter((l) => /:80\s|:443\s/.test(l) && /LISTEN/.test(l));
        if (bad.length) throw new Error(`ports 80/443 already in use:\n${bad.join('\n')}`);
      }
      ctx.log(`docker ok, ${Math.round(avail / 1024)} GB free`);
    },
  },
  {
    id: 'config',
    title: 'Config & secrets (katip.env, certs, rendered files)',
    async run(ctx) {
      const { env, changed } = ctx.ensureEnv();
      ctx.env = env;
      ctx.log(`katip.env ${changed ? 'generated' : 'present'}`);

      // dev TLS cert (*.localhost), idempotent
      const certDir = join(ctx.infra, 'traefik', 'dev-certs');
      if (!existsSync(join(certDir, 'localhost.crt'))) {
        mkdirSync(certDir, { recursive: true });
        execFileSync('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-sha256',
          '-days',
          '825',
          '-nodes',
          '-keyout',
          join(certDir, 'localhost.key'),
          '-out',
          join(certDir, 'localhost.crt'),
          '-subj',
          '/CN=localhost',
          '-addext',
          'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1',
        ]);
        ctx.log('dev TLS cert generated');
      } else {
        ctx.log('dev TLS cert present');
      }

      renderAll(ctx);
      ctx.log('rendered: litellm config, tenant files, gateway tenants');
    },
    async rollback(ctx) {
      rmSync(join(ctx.infra, 'litellm', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'librechat', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'compose', 'tenants'), { recursive: true, force: true });
      rmSync(join(STATE_DIR, 'gateway'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'env', 'tenants', 'demo.env'), { force: true });
      rmSync(join(ctx.infra, 'traefik', 'dev-certs'), { recursive: true, force: true });
    },
  },
  {
    id: 'networks',
    title: 'Networks (edge, backend)',
    async run(ctx) {
      for (const n of ['edge', 'backend']) {
        const name = `${COMPOSE_PROJECT}_${n}`;
        const exists = await tryRun('docker', ['network', 'inspect', name], {}).then(
          () => true,
          () => false,
        );
        if (!exists) {
          await tryRun('docker', ['network', 'create', name], {});
          ctx.log(`created network ${name}`);
        } else {
          ctx.log(`network ${name} present`);
        }
      }
    },
    async rollback() {
      for (const n of ['edge', 'backend']) {
        await tryRun('docker', ['network', 'rm', `${COMPOSE_PROJECT}_${n}`], {}).catch(() => {});
      }
    },
  },
  {
    id: 'images',
    title: 'Platform images (pinned)',
    async run(ctx) {
      for (const [, ref] of Object.entries(ctx.config.images)) {
        if (isInterrupted()) throw new Interrupted();
        if (typeof ref === 'object') continue; // litellm: self-built
        ctx.tui?.setDetail?.(`pulling ${ref}`);
        await tryRun('docker', ['pull', ref], {});
        ctx.log(`pulled ${ref}`);
      }
    },
  },
  {
    id: 'build',
    title: 'Build images (litellm checksum-verified, gateway, mock)',
    async run(ctx) {
      const { version, sha256 } = ctx.config.images.litellm;
      ctx.tui?.setDetail?.(`litellm ${version} (sha256 verified)`);
      await tryRun(
        'docker',
        [
          'build',
          '--build-arg',
          `LITELLM_VERSION=${version}`,
          '--build-arg',
          `LITELLM_SHA256=${sha256}`,
          '-t',
          `ghcr.io/krugis/litellm:${version}`,
          'infra/litellm',
        ],
        {},
      );
      ctx.log(`built ghcr.io/krugis/litellm:${version}`);

      ctx.tui?.setDetail?.('policy-gateway');
      await tryRun(
        'docker',
        [
          'build',
          '-t',
          'ghcr.io/krugis/policy-gateway:dev',
          '-f',
          'apps/policy-gateway/Dockerfile',
          '.',
        ],
        {},
      );
      ctx.log('built ghcr.io/krugis/policy-gateway:dev');

      ctx.tui?.setDetail?.('mock-llm');
      await tryRun(
        'docker',
        ['build', '-t', 'ghcr.io/krugis/mock-llm:dev', '-f', 'apps/mock-llm/Dockerfile', '.'],
        {},
      );
      ctx.log('built ghcr.io/krugis/mock-llm:dev');
    },
  },
  {
    id: 'platform',
    title: 'Platform services (postgres, keycloak, mongo, meili, valkey, traefik, mailpit)',
    async run(ctx) {
      ctx.tui?.setDetail?.('docker compose up --wait');
      await platformCompose(['up', '-d', '--wait'], ctx.env, ctx.config);
      ctx.log('platform healthy');
    },
    async rollback(ctx) {
      await platformCompose(['down', '-v', '--remove-orphans'], ctx.env, ctx.config).catch(
        () => {},
      );
    },
  },
  {
    id: 'aiplane',
    title: 'AI plane (mock-llm, litellm, policy-gateway) + gateway smoke',
    async run(ctx) {
      ctx.tui?.setDetail?.('docker compose up --wait');
      await platformCompose(['up', '-d', '--wait'], ctx.env, ctx.config);
      await waitUntil(async () => (await curlBackend('/healthz', ctx.env)).includes('ok'), {
        timeoutMs: 180_000,
        onTick: () => ctx.tui?.setDetail?.('waiting for gateway healthz'),
      });
      const body = await curlBackend('/v1/chat/completions', ctx.env, [
        '-H',
        `authorization: Bearer ${ctx.env.KATIP_DEMO_GATEWAY_KEY}`,
        '-H',
        'content-type: application/json',
        '-H',
        'x-user-email: demo@example.com',
        '-d',
        '{"model":"fast","messages":[{"role":"user","content":"merhaba"}],"max_tokens":32}',
      ]);
      if (!body.includes('Echo:')) throw new Error(`gateway smoke failed: ${body.slice(0, 300)}`);
      ctx.log('gateway smoke ok (chat through gateway → mock)');
    },
    async rollback(ctx) {
      await platformCompose(['down', '-v', '--remove-orphans'], ctx.env, ctx.config).catch(
        () => {},
      );
    },
  },
  {
    id: 'tenant',
    title: 'Demo tenant (LibreChat up, traefik route)',
    async run(ctx) {
      renderTenantFiles(ctx);
      await tenantCompose(['up', '-d', '--wait'], ctx.env, ctx.config);
      const base = ctx.config.project.base_domain;
      await waitUntil(
        async () => {
          const code = await curlEdge(`${ctx.config.tenant.slug}.${base}`, '/', ctx.env);
          return ['200', '301', '302', '307', '308'].includes(code.trim());
        },
        {
          timeoutMs: 180_000,
          onTick: () => ctx.tui?.setDetail?.('waiting for LibreChat behind traefik'),
        },
      );
      ctx.log(`demo tenant healthy at https://${ctx.config.tenant.slug}.${base}`);
    },
    async rollback(ctx) {
      await tenantCompose(['down', '-v', '--remove-orphans'], ctx.env, ctx.config).catch(() => {});
    },
  },
  {
    id: 'smoke',
    title: 'End-to-end smoke (models + final report)',
    async run(ctx) {
      const models = await curlBackend('/v1/models', ctx.env, [
        '-H',
        `authorization: Bearer ${ctx.env.KATIP_DEMO_GATEWAY_KEY}`,
        '-H',
        'x-user-email: demo@example.com',
      ]);
      if (!models.includes('auto'))
        throw new Error(`gateway /v1/models failed: ${models.slice(0, 200)}`);
      ctx.log('e2e smoke ok');
    },
  },
];
