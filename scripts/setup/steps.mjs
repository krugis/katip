// SPDX-License-Identifier: AGPL-3.0-only
// Bootstrap steps (P0-12…P0-21). Each step: id, title, run(ctx), rollback?(ctx).
// Steps are layers: a step is done only after its health checks pass, so
// completed layers always work standalone after an interrupt.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeEnv, identityInput, renderLiteLLMModels, seedInput } from './config.mjs';
import { tryRun, ROOT, Interrupted, isInterrupted } from './util.mjs';

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
  'KATIP_LC_OIDC_CLIENT_SECRET',
  'KATIP_LC_OIDC_SESSION_SECRET',
  'KATIP_DEMO_USER_PASSWORD',
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

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

const edgeNetwork = (config) => `${config.project.name}_edge`;
const backendNetwork = (config) => `${config.project.name}_backend`;
const tenantProject = (config) => `${config.project.name}-${config.tenant.slug}`;
const tenantFile = (config) => `infra/compose/tenants/${config.tenant.slug}.yml`;

/** `docker compose` arguments for the platform stack (project name comes from the env). */
export const platformComposeArgs = () => [
  'compose',
  '--env-file',
  'infra/env/katip.env',
  '-f',
  'infra/compose/platform.yml',
  '-f',
  'infra/compose/dev.yml',
];

/** `docker compose` arguments for the rendered tenant stack. */
export const tenantComposeArgs = (config) => [
  'compose',
  '--env-file',
  'infra/env/katip.env',
  '-f',
  tenantFile(config),
  '-p',
  tenantProject(config),
];

/** The `platform` step's services; the AI plane starts after the DB is migrated. */
const PLATFORM_SERVICES = [
  'traefik',
  'postgres',
  'keycloak',
  'mongodb',
  'meilisearch',
  'valkey',
  'mailpit',
];

const platformCompose = (args, ctx) =>
  tryRun('docker', [...platformComposeArgs(), ...args], {
    env: { ...ctx.env, ...composeEnv(ctx.config) },
  });

const tenantCompose = (args, ctx) =>
  tryRun('docker', [...tenantComposeArgs(ctx.config), ...args], {
    env: { ...ctx.env, ...composeEnv(ctx.config) },
  });

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

/** Traefik's IP on the edge network (for *.localhost resolution in checks). */
async function traefikEdgeIp(ctx) {
  const r = await tryRun(
    'docker',
    [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      `${ctx.config.project.name}-traefik-1`,
    ],
    {},
  );
  return r.out.trim();
}

/** curl from a throwaway container inside the backend network. */
const curlBackend = (ctx, path, extra = []) =>
  dockerRun(
    [
      '--network',
      backendNetwork(ctx.config),
      ctx.config.images.curl,
      '-sS',
      '-m',
      '10',
      `http://policy-gateway:8080${path}`,
      ...extra,
    ],
    ctx.env,
  ).then((r) => r.out);

/** curl via traefik from the edge network. curl resolves *.localhost to
 * 127.0.0.1 (RFC 6761), so we hit the traefik IP directly with a Host header. */
async function curlEdge(ctx, host, path, extra = []) {
  const ip = await traefikEdgeIp(ctx);
  return dockerRun(
    [
      '--network',
      edgeNetwork(ctx.config),
      ctx.config.images.curl,
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
    ctx.env,
  ).then((r) => r.out);
}

/**
 * Runs a scripts/setup/*.mjs file on the edge network, reaching Keycloak and the
 * tenant through Traefik as a browser would. Uses the gateway image as a node runtime.
 */
function runOnEdge(ctx, script, extraEnv = {}) {
  const env = {
    KC_URL: `https://auth.${ctx.config.project.base_domain}`,
    KC_ADMIN_USER: ctx.env.KC_BOOTSTRAP_ADMIN_USER,
    KC_ADMIN_PASSWORD: ctx.env.KC_BOOTSTRAP_ADMIN_PASSWORD,
    KATIP_IDENTITY: JSON.stringify(identityInput(ctx.config)),
    ...extraEnv,
  };
  return dockerRun(
    [
      '--network',
      edgeNetwork(ctx.config),
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      '-e',
      'NODE_EXTRA_CA_CERTS=/certs/dev-ca.crt',
      '-v',
      `${join(ROOT, 'scripts', 'setup')}:/setup:ro`,
      '-v',
      `${join(ctx.infra, 'traefik', 'dev-certs', 'localhost.crt')}:/certs/dev-ca.crt:ro`,
      '--entrypoint',
      'node',
      'ghcr.io/krugis/policy-gateway:dev',
      `/setup/${script}`,
    ],
    env,
  );
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------

/** Replaces every ${NAME} in `tmpl` listed in `vars`; leaves the others alone. */
const fill = (tmpl, vars) =>
  tmpl.replace(/\$\{([A-Z0-9_]+)\}/g, (all, name) => (name in vars ? vars[name] : all));

function renderLiteLLMConfig(ctx) {
  const tmpl = readFileSync(join(ctx.infra, 'litellm', 'config.dev.tmpl.yaml'), 'utf8');
  const out = tmpl.replace('%%MODELS%%', () => renderLiteLLMModels(ctx.config, ctx.env));
  mkdirSync(join(ctx.infra, 'litellm', 'rendered'), { recursive: true });
  writeFileSync(join(ctx.infra, 'litellm', 'rendered', 'config.dev.yaml'), out);
}

const ipallowFile = (ctx) =>
  join(ctx.infra, 'traefik', 'dynamic', `${ctx.config.tenant.slug}-ipallow.yml`);

function renderTenantFiles(ctx) {
  const { slug } = ctx.config.tenant;
  const base = ctx.config.project.base_domain;
  const envDir = join(ctx.infra, 'env', 'tenants');
  mkdirSync(envDir, { recursive: true });

  // tenant env
  const tmplEnv = readFileSync(join(ctx.infra, 'env', 'tenant.example.env'), 'utf8');
  const envContent = fill(tmplEnv, {
    KATIP_SLUG: slug,
    KATIP_BASE_DOMAIN: base,
    KATIP_MONGO_PASSWORD: ctx.env.MONGO_PASSWORD,
    KATIP_MEILI_MASTER_KEY: ctx.env.MEILI_MASTER_KEY,
    KATIP_LC_CREDS_KEY: ctx.env.KATIP_LC_CREDS_KEY,
    KATIP_LC_CREDS_IV: ctx.env.KATIP_LC_CREDS_IV,
    KATIP_LC_JWT_SECRET: ctx.env.KATIP_LC_JWT_SECRET,
    KATIP_LC_JWT_REFRESH_SECRET: ctx.env.KATIP_LC_JWT_REFRESH_SECRET,
    KATIP_REALM: ctx.config.identity.realm,
    KATIP_LC_OIDC_CLIENT_SECRET: ctx.env.KATIP_LC_OIDC_CLIENT_SECRET,
    KATIP_LC_OIDC_SESSION_SECRET: ctx.env.KATIP_LC_OIDC_SESSION_SECRET,
  });
  writeFileSync(join(envDir, `${slug}.env`), envContent, { mode: 0o600 });
  chmodSync(join(envDir, `${slug}.env`), 0o600);

  // librechat.yaml
  const tmplLc = readFileSync(join(ctx.infra, 'librechat', 'librechat.tmpl.yaml'), 'utf8');
  const lc = fill(tmplLc, { KATIP_DEMO_GATEWAY_KEY: ctx.env.KATIP_DEMO_GATEWAY_KEY }).replace(
    /<slug>/g,
    slug,
  );
  const lcDir = join(ctx.infra, 'librechat', 'rendered');
  mkdirSync(lcDir, { recursive: true });
  writeFileSync(join(lcDir, `${slug}.librechat.yaml`), lc, { mode: 0o600 });

  // tenant compose file
  const tmplCompose = readFileSync(join(ctx.infra, 'compose', 'tenant.tmpl.yml'), 'utf8');
  const comp = fill(tmplCompose, {
    KATIP_SLUG: slug,
    KATIP_BASE_DOMAIN: base,
    KATIP_IMAGE_LIBRECHAT: ctx.config.images.librechat,
    KATIP_COMPOSE_PROJECT: ctx.config.project.name,
  });
  const tDir = join(ctx.infra, 'compose', 'tenants');
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, `${slug}.yml`), comp);

  // Traefik ipallow middleware the tenant router refers to
  const tmplIp = readFileSync(join(ctx.infra, 'traefik', 'tenant-ipallow.tmpl.yml'), 'utf8');
  writeFileSync(ipallowFile(ctx), fill(tmplIp, { KATIP_SLUG: slug }));
}

function renderAll(ctx) {
  renderLiteLLMConfig(ctx);
  renderTenantFiles(ctx);
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

      // dev TLS cert; regenerated when its hostnames change. Node rejects a wildcard
      // on a two-label name (*.localhost), so the names containers use are listed too.
      const base = ctx.config.project.base_domain;
      const hosts = [base, `*.${base}`, `auth.${base}`, `mailpit.${base}`];
      hosts.push(`${ctx.config.tenant.slug}.${base}`);
      const san = `${hosts.map((h) => `DNS:${h}`).join(',')},IP:127.0.0.1`;
      const certDir = join(ctx.infra, 'traefik', 'dev-certs');
      const marker = join(certDir, 'domain');
      const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null;
      if (!existsSync(join(certDir, 'localhost.crt')) || current !== san) {
        mkdirSync(certDir, { recursive: true });
        execFileSync(
          'openssl',
          [
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
            `/CN=${base}`,
            '-addext',
            `subjectAltName=${san}`,
          ],
          { stdio: 'ignore' },
        );
        writeFileSync(marker, `${san}\n`);
        ctx.certRegenerated = true;
        ctx.log('dev TLS cert generated');
      } else {
        ctx.log('dev TLS cert present');
      }

      renderAll(ctx);
      ctx.log('rendered: litellm config, tenant files, traefik ipallow');
    },
    async rollback(ctx) {
      const { slug } = ctx.config.tenant;
      rmSync(join(ctx.infra, 'litellm', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'librechat', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'compose', 'tenants'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'env', 'tenants', `${slug}.env`), { force: true });
      rmSync(ipallowFile(ctx), { force: true });
      rmSync(join(ctx.infra, 'traefik', 'dev-certs'), { recursive: true, force: true });
    },
  },
  {
    id: 'networks',
    title: 'Networks (edge, backend)',
    async run(ctx) {
      for (const name of [edgeNetwork(ctx.config), backendNetwork(ctx.config)]) {
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
    async rollback(ctx) {
      for (const name of [edgeNetwork(ctx.config), backendNetwork(ctx.config)]) {
        await tryRun('docker', ['network', 'rm', name], {}).catch(() => {});
      }
    },
  },
  {
    id: 'images',
    title: 'Platform images (pinned)',
    async run(ctx) {
      for (const [, ref] of Object.entries(ctx.config.images)) {
        if (isInterrupted()) throw new Interrupted();
        if (typeof ref === 'object') continue; // self-built: see the build step
        ctx.tui?.setDetail?.(`pulling ${ref}`);
        await tryRun('docker', ['pull', ref], {});
        ctx.log(`pulled ${ref}`);
      }
    },
  },
  {
    id: 'build',
    title: 'Build images (litellm + presidio checksum-verified, gateway, mock)',
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

      const presidio = ctx.config.images.presidio_analyzer;
      ctx.tui?.setDetail?.(`presidio ${presidio.version} (spaCy model sha256 verified)`);
      await tryRun(
        'docker',
        [
          'build',
          '--build-arg',
          `PRESIDIO_REGISTRY=${presidio.registry}`,
          '--build-arg',
          `PRESIDIO_VERSION=${presidio.version}`,
          '--build-arg',
          `SPACY_MODEL_VERSION=${presidio.spacy_model_version}`,
          '--build-arg',
          `SPACY_MODEL_SHA256=${presidio.spacy_model_sha256}`,
          '-t',
          `ghcr.io/krugis/presidio-analyzer:${presidio.version}`,
          'infra/presidio',
        ],
        {},
      );
      ctx.log(`built ghcr.io/krugis/presidio-analyzer:${presidio.version}`);

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
      await platformCompose(['up', '-d', '--wait', ...PLATFORM_SERVICES], ctx);
      // Traefik only reads the certificate when it starts.
      if (ctx.certRegenerated) {
        await platformCompose(
          ['up', '-d', '--wait', '--force-recreate', '--no-deps', 'traefik'],
          ctx,
        );
      }
      ctx.log('platform healthy');
    },
    async rollback(ctx) {
      await platformCompose(['down', '-v', '--remove-orphans'], ctx).catch(() => {});
    },
  },
  {
    id: 'identity',
    title: 'Identity (Keycloak realm, login flow, tenant client, demo users)',
    async run(ctx) {
      await runOnEdge(ctx, 'keycloak.mjs', {
        LC_CLIENT_SECRET: ctx.env.KATIP_LC_OIDC_CLIENT_SECRET,
        DEMO_USER_PASSWORD: ctx.env.KATIP_DEMO_USER_PASSWORD,
      });
      ctx.log(`realm ${ctx.config.identity.realm} applied`);
    },
  },
  {
    id: 'governance-db',
    title: 'Governance DB (migrate, seed, demo gateway key)',
    async run(ctx) {
      // Runs the repo's migrate + seed + demo-key upsert inside the gateway
      // image (node + our built packages) on the backend network.
      const env = {
        DATABASE_URL: `postgres://katip:${ctx.env.POSTGRES_PASSWORD}@postgres:5432/governance`,
        KATIP_DEMO_GATEWAY_KEY: ctx.env.KATIP_DEMO_GATEWAY_KEY,
        KATIP_SEED: JSON.stringify(seedInput(ctx.config)),
      };
      await dockerRun(
        [
          '--network',
          backendNetwork(ctx.config),
          '-e',
          'DATABASE_URL',
          '-e',
          'KATIP_DEMO_GATEWAY_KEY',
          '-e',
          'KATIP_SEED',
          '--entrypoint',
          'node',
          '-w',
          '/app/policy-gateway',
          '-v',
          `${join(ROOT, 'scripts', 'setup', 'db-seed.mjs')}:/app/policy-gateway/db-seed.mjs:ro`,
          'ghcr.io/krugis/policy-gateway:dev',
          'db-seed.mjs',
        ],
        env,
      );
      ctx.log('migrations + seed applied; demo gateway key stored (argon2id)');
    },
  },
  {
    id: 'aiplane',
    title: 'AI plane (mock-llm, litellm, presidio, policy-gateway) + gateway smoke',
    async run(ctx) {
      ctx.tui?.setDetail?.('docker compose up --wait');
      await platformCompose(['up', '-d', '--wait'], ctx);
      // Compose doesn't notice a changed bind-mounted file, so reload it.
      if (ctx.configChanged) {
        await platformCompose(
          ['up', '-d', '--wait', '--force-recreate', '--no-deps', 'litellm'],
          ctx,
        );
      }
      await waitUntil(async () => (await curlBackend(ctx, '/readyz')).includes('"ok"'), {
        timeoutMs: 180_000,
        onTick: () => ctx.tui?.setDetail?.('waiting for gateway readyz'),
      });
      const body = await curlBackend(ctx, '/v1/chat/completions', [
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
      await platformCompose(['down', '-v', '--remove-orphans'], ctx).catch(() => {});
    },
  },
  {
    id: 'tenant',
    title: 'Demo tenant (LibreChat up, traefik route)',
    async run(ctx) {
      renderTenantFiles(ctx);
      await tenantCompose(
        ['up', '-d', '--wait', ...(ctx.configChanged ? ['--force-recreate'] : [])],
        ctx,
      );
      const base = ctx.config.project.base_domain;
      await waitUntil(
        async () => {
          const code = await curlEdge(ctx, `${ctx.config.tenant.slug}.${base}`, '/');
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
      await tenantCompose(['down', '-v', '--remove-orphans'], ctx).catch(() => {});
    },
  },
  {
    id: 'smoke',
    title: 'End-to-end smoke (models, login with MFA + final report)',
    async run(ctx) {
      const models = await curlBackend(ctx, '/v1/models', [
        '-H',
        `authorization: Bearer ${ctx.env.KATIP_DEMO_GATEWAY_KEY}`,
        '-H',
        'x-user-email: demo@example.com',
      ]);
      if (!models.includes('auto'))
        throw new Error(`gateway /v1/models failed: ${models.slice(0, 200)}`);
      await runOnEdge(ctx, 'oidc-smoke.mjs');
      ctx.log('e2e smoke ok (models, login with MFA, non-member refused)');
    },
  },
];

/** Steps that only hold while the containers run; `dev:down` makes them pending again. */
export const SERVICE_STEPS = ['platform', 'aiplane', 'tenant', 'smoke'];

/** Steps a config change doesn't affect, so they stay done when re-applying. */
export const KEEP_ON_CONFIG_CHANGE = new Set(['preflight', 'networks']);
