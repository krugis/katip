// SPDX-License-Identifier: AGPL-3.0-only
// Bootstrap steps (P0-12…P0-21). Each step: id, title, run(ctx), rollback?(ctx).
// Steps are layers: a step is done only after its health checks pass, so
// completed layers always work standalone after an interrupt.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  composeEnv,
  identityInput,
  platformIdentityInput,
  provisionInput,
  renderLiteLLMModels,
  seedInput,
  tenantNetworkName,
  tenantSecretName,
  pickTenantSubnet,
  tenantInputErrors,
} from './config.mjs';
import { checkIsolation } from './isolation.mjs';
import { ensureTenantSecrets, knownTenantSlugs, tenantSecretsFile } from './tenants.mjs';
import { run, tryRun, ROOT, Interrupted, isInterrupted } from './util.mjs';

export const AUTO_KEYS = new Set([
  'POSTGRES_PASSWORD',
  'KC_DB_PASSWORD',
  'LITELLM_DB_PASSWORD',
  'KC_BOOTSTRAP_ADMIN_PASSWORD',
  'MONGO_PASSWORD',
  'LITELLM_MASTER_KEY',
  'MOCK_LLM_KEY',
  'KATIP_PII_TOKEN_KEY',
  'VALKEY_PASSWORD',
  'KATIP_GATEWAY_DB_PASSWORD',
  'KATIP_CONSOLE_DB_PASSWORD',
  'KATIP_PROVIDER_DB_PASSWORD',
  'KATIP_PROVISIONER_KC_SECRET',
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

/** Must match TOOL_TRIGGER in apps/mock-llm: it makes the mock call the first tool. */
const TOOL_TRIGGER = '[[use-tool]]';

const edgeNetwork = (config) => `${config.project.name}_edge`;
const backendNetwork = (config) => `${config.project.name}_backend`;
const tenantProject = (config, t) => `${config.project.name}-${t.slug}`;
const tenantFile = (t) => `infra/compose/tenants/${t.slug}.yml`;
const tenantSecret = (ctx, t, name) => ctx.env[tenantSecretName(t.slug, name)];
const RENDERED_COMPOSE = 'infra/compose/rendered/tenants.yml';

/** `docker compose` arguments for the platform stack (project name comes from the env). */
export const platformComposeArgs = () => [
  'compose',
  '--env-file',
  'infra/env/katip.env',
  '-f',
  'infra/compose/platform.yml',
  '-f',
  'infra/compose/dev.yml',
  '-f',
  RENDERED_COMPOSE,
];

/** `docker compose` arguments for the rendered tenant stack. */
export const tenantComposeArgs = (config, t) => [
  'compose',
  '--env-file',
  'infra/env/katip.env',
  '-f',
  tenantFile(t),
  '-p',
  tenantProject(config, t),
];

/** The `platform` step's services; the AI plane starts after the DB is migrated. */
const PLATFORM_SERVICES = ['traefik', 'postgres', 'keycloak', 'mongodb', 'valkey', 'mailpit'];

const platformCompose = (args, ctx) =>
  tryRun('docker', [...platformComposeArgs(), ...args], {
    env: { ...ctx.env, ...composeEnv(ctx.config) },
  });

const tenantCompose = (args, ctx, t) =>
  tryRun('docker', [...tenantComposeArgs(ctx.config, t), ...args], {
    env: { ...ctx.env, ...composeEnv(ctx.config) },
  });

/**
 * Runs a throwaway container. Docker can lose a container's exit event, and then
 * `docker run` waits forever for a process that already ended, so every run has a
 * time limit, and the container is removed if it hits it.
 */
export async function dockerRun(args, env = {}, { timeoutMs = 300_000, attempts = 1 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const name = `katip-tool-${randomBytes(6).toString('hex')}`;
    try {
      return await tryRun('docker', ['run', '--rm', '--name', name, ...args], { env, timeoutMs });
    } catch (e) {
      if (e.name !== 'TimedOut') throw e;
      await run('docker', ['rm', '-f', name]).catch(() => {});
      if (attempt >= attempts) throw e;
    }
  }
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
      `{{(index .NetworkSettings.Networks "${edgeNetwork(ctx.config)}").IPAddress}}`,
      `${ctx.config.project.name}-traefik-1`,
    ],
    {},
  );
  return r.out.trim();
}

/** curl itself gives up after 10 s, so these limits only catch Docker losing track of it. */
const CURL_LIMITS = { timeoutMs: 30_000, attempts: 3 };

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
    CURL_LIMITS,
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
    CURL_LIMITS,
  ).then((r) => r.out);
}

/**
 * Runs a scripts/setup/*.mjs file on a network with Traefik on it (default: edge), reaching
 * Keycloak and the tenant as a browser would. Uses the gateway image as a node runtime.
 */
function runOnEdge(
  ctx,
  t,
  script,
  extraEnv = {},
  network = edgeNetwork(ctx.config),
  identity = identityInput(ctx.config, t),
) {
  const env = {
    KC_URL: `https://auth.${ctx.config.project.base_domain}`,
    KC_ADMIN_USER: ctx.env.KC_BOOTSTRAP_ADMIN_USER,
    KC_ADMIN_PASSWORD: ctx.env.KC_BOOTSTRAP_ADMIN_PASSWORD,
    KATIP_IDENTITY: JSON.stringify(identity),
    ...extraEnv,
  };
  return dockerRun(
    [
      '--network',
      network,
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

/**
 * The gateway's usage row is the proof that LibreChat's headers arrived: its user comes
 * from X-User-Email and its conversation id from X-Conversation-Id (P1-05).
 */
/**
 * A tool call on the real path, through LiteLLM: the arguments must leave the gateway
 * masked, and the usage row must hold the tool's name (LLD-03 §5).
 */
async function checkToolCallPath(ctx, t) {
  const conversation = `smoke-tool-${randomBytes(6).toString('hex')}`;
  const payload = {
    model: 'fast',
    max_tokens: 32,
    messages: [{ role: 'user', content: `${TOOL_TRIGGER} TCKN 10000000146` }],
    tools: [{ type: 'function', function: { name: 'smoke_tool', parameters: { type: 'object' } } }],
  };
  const body = await curlBackend(ctx, '/v1/chat/completions', [
    '-H',
    `authorization: Bearer ${tenantSecret(ctx, t, 'GATEWAY_KEY')}`,
    '-H',
    'content-type: application/json',
    '-H',
    'x-user-email: demo@example.com',
    '-H',
    `x-conversation-id: ${conversation}`,
    '-d',
    JSON.stringify(payload),
  ]);
  if (!body.includes('smoke_tool')) {
    throw new Error(`no tool call came back for ${t.slug}: ${body.slice(0, 200)}`);
  }
  if (body.includes('10000000146') || !body.includes('TR_TCKN_')) {
    throw new Error(`tool arguments were not masked for ${t.slug}`);
  }
  const sql =
    `select count(*) from usage_events where conversation_id = '${conversation}' ` +
    `and tool_calls = array['smoke_tool']`;
  await waitUntil(
    async () => {
      const { out } = await platformCompose(
        ['exec', '-T', 'postgres', 'psql', '-U', 'katip', '-d', 'governance', '-At', '-c', sql],
        ctx,
      );
      return parseInt(out.trim(), 10) > 0;
    },
    { timeoutMs: 30_000, intervalMs: 2000 },
  ).catch(() => {
    throw new Error(`the gateway did not record the tool call for ${t.slug}`);
  });
}

async function checkUsageRecorded(ctx, t, smokeOutput) {
  const id = smokeOutput.match(/chat-conversation=([\w-]+)/)?.[1];
  if (!id) throw new Error('the smoke test reported no conversation id');
  const { smokeEmail } = identityInput(ctx.config, t);
  const sql =
    `select count(*) from usage_events e join users u on u.id = e.user_id ` +
    `where e.conversation_id = '${id}' and u.email = '${smokeEmail}'`;
  await waitUntil(
    async () => {
      const { out } = await platformCompose(
        ['exec', '-T', 'postgres', 'psql', '-U', 'katip', '-d', 'governance', '-At', '-c', sql],
        ctx,
      );
      return parseInt(out.trim(), 10) > 0;
    },
    { timeoutMs: 30_000, intervalMs: 2000 },
  ).catch(() => {
    throw new Error('the gateway recorded no usage for this user and conversation');
  });
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

/** Every tenant on this host: the ones in the config, and any made by `pnpm tenant:create`. */
export const allTenants = (ctx) => {
  const slugs = new Set([...ctx.config.tenants.map((t) => t.slug), ...knownTenantSlugs(ctx.infra)]);
  return [...slugs].sort().map((slug) => ({ slug }));
};

/** Makes the tenant secrets available to everything that renders or runs. */
export function loadAllTenantSecrets(ctx) {
  for (const t of allTenants(ctx)) Object.assign(ctx.env, ensureTenantSecrets(ctx.infra, t.slug));
}

const ipallowFile = (ctx, t) => join(ctx.infra, 'traefik', 'dynamic', `${t.slug}-ipallow.yml`);

/**
 * What the tenants add to the platform stack. Generated as a compose file so that
 * compose keeps it on every recreate. Dev has no DNS: containers reach public
 * hostnames through Traefik, using the same Keycloak URL as the browser.
 */
function renderPlatformOverlay(ctx) {
  const base = ctx.config.project.base_domain;
  const overlay = {
    services: {
      traefik: { networks: { edge: { aliases: [`auth.${base}`] } } },
      'policy-gateway': { networks: {} },
      mongodb: { networks: {} },
    },
    networks: {},
  };
  // Each tenant's network holds its LibreChat and search, plus only the platform
  // services a tenant may use. Postgres, Valkey, LiteLLM and other tenants aren't on it.
  for (const t of allTenants(ctx)) {
    const key = `t_${t.slug}`;
    overlay.networks[key] = { name: tenantNetworkName(ctx.config, t), external: true };
    overlay.services.traefik.networks[key] = {
      aliases: [`auth.${base}`, `console.${base}`, `${t.slug}.${base}`],
    };
    overlay.services['policy-gateway'].networks[key] = {};
    overlay.services.mongodb.networks[key] = {};
  }
  mkdirSync(join(ROOT, 'infra', 'compose', 'rendered'), { recursive: true });
  // JSON is valid YAML.
  writeFileSync(join(ROOT, RENDERED_COMPOSE), `${JSON.stringify(overlay, null, 2)}\n`);
}

function renderTenantFiles(ctx, t) {
  const { slug } = t;
  const base = ctx.config.project.base_domain;
  const envDir = join(ctx.infra, 'env', 'tenants');
  mkdirSync(envDir, { recursive: true });

  // tenant env
  const tmplEnv = readFileSync(join(ctx.infra, 'env', 'tenant.example.env'), 'utf8');
  const envContent = fill(tmplEnv, {
    KATIP_SLUG: slug,
    KATIP_BASE_DOMAIN: base,
    KATIP_MONGO_PASSWORD: tenantSecret(ctx, t, 'MONGO_PASSWORD'),
    KATIP_MEILI_MASTER_KEY: tenantSecret(ctx, t, 'MEILI_KEY'),
    KATIP_LC_CREDS_KEY: tenantSecret(ctx, t, 'LC_CREDS_KEY'),
    KATIP_LC_CREDS_IV: tenantSecret(ctx, t, 'LC_CREDS_IV'),
    KATIP_LC_JWT_SECRET: tenantSecret(ctx, t, 'LC_JWT_SECRET'),
    KATIP_LC_JWT_REFRESH_SECRET: tenantSecret(ctx, t, 'LC_JWT_REFRESH_SECRET'),
    KATIP_REALM: ctx.config.identity.realm,
    KATIP_LC_OIDC_CLIENT_SECRET: tenantSecret(ctx, t, 'LC_OIDC_CLIENT_SECRET'),
    KATIP_LC_OIDC_SESSION_SECRET: tenantSecret(ctx, t, 'LC_OIDC_SESSION_SECRET'),
  });
  writeFileSync(join(envDir, `${slug}.env`), envContent, { mode: 0o600 });
  chmodSync(join(envDir, `${slug}.env`), 0o600);
  const meiliEnv = `MEILI_MASTER_KEY=${tenantSecret(ctx, t, 'MEILI_KEY')}\n`;
  writeFileSync(join(envDir, `${slug}.meili.env`), meiliEnv, { mode: 0o600 });
  chmodSync(join(envDir, `${slug}.meili.env`), 0o600);

  // librechat.yaml
  const tmplLc = readFileSync(join(ctx.infra, 'librechat', 'librechat.tmpl.yaml'), 'utf8');
  const lc = fill(tmplLc, {
    KATIP_TENANT_GATEWAY_KEY: tenantSecret(ctx, t, 'GATEWAY_KEY'),
  }).replace(/<slug>/g, slug);
  const lcDir = join(ctx.infra, 'librechat', 'rendered');
  mkdirSync(lcDir, { recursive: true });
  writeFileSync(join(lcDir, `${slug}.librechat.yaml`), lc, { mode: 0o600 });

  // tenant compose file
  const tmplCompose = readFileSync(join(ctx.infra, 'compose', 'tenant.tmpl.yml'), 'utf8');
  const comp = fill(tmplCompose, {
    KATIP_SLUG: slug,
    KATIP_BASE_DOMAIN: base,
    KATIP_IMAGE_LIBRECHAT: ctx.config.images.librechat,
    KATIP_IMAGE_MEILISEARCH: ctx.config.images.meilisearch,
    KATIP_COMPOSE_PROJECT: ctx.config.project.name,
  });
  const tDir = join(ctx.infra, 'compose', 'tenants');
  mkdirSync(tDir, { recursive: true });
  writeFileSync(join(tDir, `${slug}.yml`), comp);

  // Traefik ipallow middleware the tenant router refers to
  const tmplIp = readFileSync(join(ctx.infra, 'traefik', 'tenant-ipallow.tmpl.yml'), 'utf8');
  writeFileSync(ipallowFile(ctx, t), fill(tmplIp, { KATIP_SLUG: slug }));
}

function renderAll(ctx) {
  renderLiteLLMConfig(ctx);
  renderPlatformOverlay(ctx);
  for (const t of allTenants(ctx)) renderTenantFiles(ctx, t);
}

/** A new tenant's network gets a subnet no other network here uses. Docker remembers it. */
async function ensureTenantNetwork(ctx, t) {
  const name = tenantNetworkName(ctx.config, t);
  const exists = await run('docker', ['network', 'inspect', name]);
  if (exists.code === 0) return;
  const { out: ids } = await tryRun('docker', ['network', 'ls', '-q']);
  const { out } = await tryRun('docker', [
    'network',
    'inspect',
    '-f',
    '{{range .IPAM.Config}}{{.Subnet}} {{end}}',
    ...ids.split(/\s+/).filter(Boolean),
  ]);
  const subnet = pickTenantSubnet(ctx.config, t, out.split(/\s+/).filter(Boolean));
  await tryRun('docker', ['network', 'create', '--subnet', subnet, name]);
}

/**
 * Attaches the platform services a tenant may use, with no restart. The generated compose
 * file keeps this on a recreate; this is for when the stack is already running.
 */
async function connectPlatformToTenant(ctx, t) {
  const base = ctx.config.project.base_domain;
  const network = tenantNetworkName(ctx.config, t);
  const services = [
    ['traefik', [`auth.${base}`, `console.${base}`, `${t.slug}.${base}`]],
    // Compose only names a service on networks it attached itself.
    ['policy-gateway', ['policy-gateway']],
    ['mongodb', ['mongodb']],
  ];
  for (const [service, aliases] of services) {
    const container = `${ctx.config.project.name}-${service}-1`;
    const running = await run('docker', ['inspect', '-f', '{{.State.Running}}', container]);
    if (running.out.trim() !== 'true') continue;
    const connected = await run('docker', [
      'inspect',
      '-f',
      `{{if index .NetworkSettings.Networks "${network}"}}yes{{end}}`,
      container,
    ]);
    if (connected.out.trim() !== 'yes') {
      const flags = aliases.flatMap((a) => ['--alias', a]);
      await tryRun('docker', ['network', 'connect', ...flags, network, container]);
    }
  }
}

/** Runs one stage of the provisioner. The Docker work stays here, on the host. */
async function runProvisioner(ctx, t, action, extra = {}) {
  const env = {
    DATABASE_URL: `postgres://katip_provider:${ctx.env.KATIP_PROVIDER_DB_PASSWORD}@postgres:5432/governance`,
    KEYCLOAK_URL: 'http://keycloak:8080',
    KEYCLOAK_REALM: ctx.config.identity.realm,
    KEYCLOAK_CLIENT_ID: 'katip-provisioner',
    KEYCLOAK_CLIENT_SECRET: ctx.env.KATIP_PROVISIONER_KC_SECRET,
    MONGO_ROOT_URI: `mongodb://${ctx.env.MONGO_USER}:${ctx.env.MONGO_PASSWORD}@mongodb:27017/?authSource=admin`,
    TENANT_ACTION: action,
    TENANT_INPUT: JSON.stringify(provisionInput(ctx.config, t)),
    TENANT_GATEWAY_KEY: tenantSecret(ctx, t, 'GATEWAY_KEY'),
    TENANT_OIDC_CLIENT_SECRET: tenantSecret(ctx, t, 'LC_OIDC_CLIENT_SECRET'),
    TENANT_MONGO_PASSWORD: tenantSecret(ctx, t, 'MONGO_PASSWORD'),
    ...extra,
  };
  const { out } = await dockerRun(
    [
      '--network',
      backendNetwork(ctx.config),
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      'ghcr.io/krugis/provisioner:dev',
    ],
    env,
    { timeoutMs: 180_000 },
  );
  const line = out.split('\n').find((l) => l.startsWith('provision-result='));
  if (!line) throw new Error(`the provisioner reported no result: ${out.slice(0, 300)}`);
  return JSON.parse(line.slice('provision-result='.length));
}

/** The tenant's data, login client, network and gateway key. Its LibreChat comes next. */
export async function provisionTenant(ctx, t) {
  const errors = tenantInputErrors(t);
  if (errors.length > 0) throw new Error(`tenant ${t.slug}: ${errors.join('; ')}`);
  Object.assign(ctx.env, ensureTenantSecrets(ctx.infra, t.slug));
  const result = await runProvisioner(ctx, t, 'create');
  // After the provisioner, so a refused tenant leaves no network behind.
  await ensureTenantNetwork(ctx, t);
  renderPlatformOverlay(ctx);
  await connectPlatformToTenant(ctx, t);
  return result;
}

/** Renders the tenant's files and starts its search and LibreChat, behind Traefik. */
async function startTenant(ctx, t, { recreate = false } = {}) {
  const base = ctx.config.project.base_domain;
  renderTenantFiles(ctx, t);
  await tenantCompose(
    ['up', '-d', '--wait', '--wait-timeout', '180', ...(recreate ? ['--force-recreate'] : [])],
    ctx,
    t,
  );
  await waitUntil(
    async () => (await curlEdge(ctx, `${t.slug}.${base}`, '/health')).trim() === '200',
    {
      timeoutMs: 180_000,
      onTick: () => ctx.tui?.setDetail?.(`waiting for LibreChat ${t.slug} behind traefik`),
    },
  );
  ctx.log(`tenant healthy at https://${t.slug}.${base}`);
}

const gatewayStatus = async (ctx, t, headers = []) =>
  (
    await curlBackend(ctx, '/v1/models', [
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-H',
      `authorization: Bearer ${tenantSecret(ctx, t, 'GATEWAY_KEY')}`,
      ...headers,
    ])
  ).trim();

/** What the tenant depends on: login can be discovered, and the gateway knows its key. */
async function smokeTenant(ctx, t) {
  const { base_domain: base } = ctx.config.project;
  const discovery = (
    await curlEdge(
      ctx,
      `auth.${base}`,
      `/realms/${ctx.config.identity.realm}/.well-known/openid-configuration`,
    )
  ).trim();
  if (discovery !== '200') throw new Error(`login discovery answered ${discovery}`);
  // No user yet, so the answer is "unknown user": only a key it doesn't know gets a 401.
  const status = await gatewayStatus(ctx, t);
  if (!status.startsWith('4') || status === '401') {
    throw new Error(`the gateway answered ${status} for the tenant's key`);
  }
}

/** Invites the tenant admin, then checks the gateway serves them. */
async function finishTenantSetup(ctx, t, priorSteps = []) {
  const result = await runProvisioner(ctx, t, 'finish', {
    TENANT_PRIOR_STEPS: JSON.stringify(priorSteps),
  });
  const status = await gatewayStatus(ctx, t, ['-H', `x-user-email: ${t.admin_email}`]);
  if (status !== '200') throw new Error(`the gateway answered ${status} for the tenant admin`);
  return result;
}

/**
 * Removes what a failed first attempt made, in reverse. Returns what it couldn't undo; the
 * secrets file stays in that case, so a re-run can finish the tenant instead.
 */
async function undoNewTenant(ctx, t, failedStep) {
  const problems = [];
  const attempt = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      problems.push(`${name}: ${e.message.trim().split('\n').at(-1)}`);
    }
  };
  await attempt('containers', () =>
    tryRun('docker', [
      'compose',
      '-p',
      tenantProject(ctx.config, t),
      'down',
      '-v',
      '--remove-orphans',
    ]),
  );
  await attempt('login and database', () =>
    runProvisioner(ctx, t, 'rollback', { TENANT_FAILED_STEP: failedStep }),
  );
  await attempt('governance rows', () => runDbSeed(ctx, 'forget', t.slug));
  if (problems.length > 0) return problems;

  const network = tenantNetworkName(ctx.config, t);
  for (const service of ['traefik', 'policy-gateway', 'mongodb']) {
    const container = `${ctx.config.project.name}-${service}-1`;
    await run('docker', ['network', 'disconnect', '-f', network, container]);
  }
  await run('docker', ['network', 'rm', network]);
  const envDir = join(ctx.infra, 'env', 'tenants');
  for (const file of [
    join(envDir, `${t.slug}.env`),
    join(envDir, `${t.slug}.meili.env`),
    join(ctx.infra, 'librechat', 'rendered', `${t.slug}.librechat.yaml`),
    join(ctx.infra, 'compose', 'tenants', `${t.slug}.yml`),
    ipallowFile(ctx, t),
    tenantSecretsFile(ctx.infra, t.slug),
  ]) {
    rmSync(file, { force: true });
  }
  renderPlatformOverlay(ctx);
  return problems;
}

/**
 * `pnpm tenant:create`: all the stages. A first attempt that fails leaves nothing behind. A
 * tenant that already existed is left as it was: it may be in use.
 */
export async function createAndStartTenant(ctx, t) {
  const errors = tenantInputErrors(t);
  if (errors.length > 0) throw new Error(`tenant ${t.slug}: ${errors.join('; ')}`);
  const isNew = !existsSync(tenantSecretsFile(ctx.infra, t.slug));
  let step = 'provision';
  try {
    const created = await provisionTenant(ctx, t);
    step = 'start';
    await startTenant(ctx, t);
    step = 'smoke';
    await smokeTenant(ctx, t);
    step = 'finish';
    const finished = await finishTenantSetup(ctx, t, created.changedSteps);
    const changedSteps = [...created.changedSteps, ...finished.changedSteps];
    return { alreadyExists: changedSteps.length === 0, changedSteps };
  } catch (e) {
    // The invite may be out once finish starts, so the tenant stays for a re-run.
    if (!isNew || step === 'finish') throw e;
    const failedStep = /step (\S+) failed/.exec(e.message)?.[1] ?? step;
    const problems = await undoNewTenant(ctx, t, failedStep);
    if (problems.length > 0) {
      throw new Error(
        `${e.message}\nCould not undo everything, so run the same command again to finish it:\n  ${problems.join('\n  ')}`,
      );
    }
    throw new Error(`${e.message}\nEverything this attempt made has been removed.`);
  }
}

/** Runs a stage of scripts/setup/db-seed.mjs in the gateway image, as the admin role. */
function runDbSeed(ctx, stage, ...args) {
  const env = {
    DATABASE_URL: `postgres://katip:${ctx.env.POSTGRES_PASSWORD}@postgres:5432/governance`,
    KATIP_GATEWAY_DB_PASSWORD: ctx.env.KATIP_GATEWAY_DB_PASSWORD,
    KATIP_CONSOLE_DB_PASSWORD: ctx.env.KATIP_CONSOLE_DB_PASSWORD,
    KATIP_PROVIDER_DB_PASSWORD: ctx.env.KATIP_PROVIDER_DB_PASSWORD,
    KATIP_SEED: JSON.stringify(seedInput(ctx.config)),
  };
  return dockerRun(
    [
      '--network',
      backendNetwork(ctx.config),
      ...Object.keys(env).flatMap((k) => ['-e', k]),
      '--entrypoint',
      'node',
      '-w',
      '/app/policy-gateway',
      '-v',
      `${join(ROOT, 'scripts', 'setup', 'db-seed.mjs')}:/app/policy-gateway/db-seed.mjs:ro`,
      'ghcr.io/krugis/policy-gateway:dev',
      'db-seed.mjs',
      stage,
      ...args,
    ],
    env,
  );
}

/** LibreChat rejects these when encrypting, and katip.env values are never overwritten. */
function checkCredentialFormats(ctx) {
  for (const t of allTenants(ctx)) {
    const key = tenantSecretName(t.slug, 'LC_CREDS_KEY');
    const iv = tenantSecretName(t.slug, 'LC_CREDS_IV');
    if (!/^[0-9a-f]{64}$/.test(ctx.env[key])) throw new Error(`${key} must be 64 hex characters`);
    if (!/^[0-9a-f]{32}$/.test(ctx.env[iv])) throw new Error(`${iv} must be 32 hex characters`);
  }
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
      loadAllTenantSecrets(ctx);
      checkCredentialFormats(ctx);

      // dev TLS cert; regenerated when its hostnames change. Node rejects a wildcard
      // on a two-label name (*.localhost), so the names containers use are listed too.
      const base = ctx.config.project.base_domain;
      const hosts = [base, `*.${base}`, `auth.${base}`, `mailpit.${base}`, `console.${base}`];
      hosts.push(...ctx.config.tenants.map((t) => `${t.slug}.${base}`));
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
      rmSync(join(ROOT, 'infra', 'compose', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'litellm', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'librechat', 'rendered'), { recursive: true, force: true });
      rmSync(join(ctx.infra, 'compose', 'tenants'), { recursive: true, force: true });
      for (const t of allTenants(ctx)) {
        rmSync(join(ctx.infra, 'env', 'tenants', `${t.slug}.env`), { force: true });
        rmSync(join(ctx.infra, 'env', 'tenants', `${t.slug}.meili.env`), { force: true });
        rmSync(tenantSecretsFile(ctx.infra, t.slug), { force: true });
        rmSync(ipallowFile(ctx, t), { force: true });
      }
      rmSync(join(ctx.infra, 'traefik', 'dev-certs'), { recursive: true, force: true });
    },
  },
  {
    id: 'networks',
    title: 'Networks (edge, backend, one per tenant)',
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
      for (const t of allTenants(ctx)) await ensureTenantNetwork(ctx, t);
    },
    async rollback(ctx) {
      const names = [
        edgeNetwork(ctx.config),
        backendNetwork(ctx.config),
        ...allTenants(ctx).map((t) => tenantNetworkName(ctx.config, t)),
      ];
      for (const name of names) {
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
    title:
      'Build images (litellm + presidio checksum-verified, gateway, console-api, provisioner, mock)',
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

      ctx.tui?.setDetail?.('provisioner');
      await tryRun(
        'docker',
        ['build', '-t', 'ghcr.io/krugis/provisioner:dev', '-f', 'apps/provisioner/Dockerfile', '.'],
        {},
      );
      ctx.log('built ghcr.io/krugis/provisioner:dev');

      ctx.tui?.setDetail?.('console-api');
      await tryRun(
        'docker',
        ['build', '-t', 'ghcr.io/krugis/console-api:dev', '-f', 'apps/console-api/Dockerfile', '.'],
        {},
      );
      ctx.log('built ghcr.io/krugis/console-api:dev');

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
    title: 'Platform services (postgres, keycloak, mongo, valkey, traefik, mailpit)',
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
    title: 'Identity (Keycloak realm, login flow, console and provisioner clients)',
    async run(ctx) {
      await runOnEdge(
        ctx,
        ctx.config.tenants[0],
        'keycloak.mjs',
        { PROVISIONER_CLIENT_SECRET: ctx.env.KATIP_PROVISIONER_KC_SECRET },
        edgeNetwork(ctx.config),
        platformIdentityInput(ctx.config),
      );
      ctx.log(`realm ${ctx.config.identity.realm} applied`);
    },
  },
  {
    id: 'governance-db',
    title: 'Governance DB (migrate, roles, plans, catalog)',
    async run(ctx) {
      await runDbSeed(ctx, 'platform');
      ctx.log('migrations + platform seed applied');
    },
  },
  {
    id: 'provision',
    title: 'Tenants (through the provisioner: rows, Keycloak, Mongo, network, gateway key)',
    async run(ctx) {
      for (const t of ctx.config.tenants) {
        const r = await provisionTenant(ctx, t);
        (ctx.provisioned ??= {})[t.slug] = r.changedSteps;
        ctx.log(`${t.slug}: ${r.alreadyExists ? 'already exists' : r.changedSteps.join(', ')}`);
        await runOnEdge(ctx, t, 'keycloak-dev-users.mjs', {
          DEMO_USER_PASSWORD: tenantSecret(ctx, t, 'DEMO_USER_PASSWORD'),
        });
      }
      // Dev only: demo users, and the settings from katip.config.yaml.
      await runDbSeed(ctx, 'tenants');
      ctx.log('dev tenants ready');
    },
  },
  {
    id: 'aiplane',
    title: 'Services (mock-llm, litellm, presidio, policy-gateway, console-api) + gateway smoke',
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
      for (const t of ctx.config.tenants) {
        const body = await curlBackend(ctx, '/v1/chat/completions', [
          '-H',
          `authorization: Bearer ${tenantSecret(ctx, t, 'GATEWAY_KEY')}`,
          '-H',
          'content-type: application/json',
          '-H',
          'x-user-email: demo@example.com',
          '-d',
          '{"model":"fast","messages":[{"role":"user","content":"merhaba"}],"max_tokens":32}',
        ]);
        if (!body.includes('Echo:')) {
          throw new Error(`gateway smoke failed for ${t.slug}: ${body.slice(0, 300)}`);
        }
      }
      ctx.log('gateway smoke ok (chat through gateway → mock)');
    },
    async rollback(ctx) {
      await platformCompose(['down', '-v', '--remove-orphans'], ctx).catch(() => {});
    },
  },
  {
    id: 'tenant',
    title: 'Tenants (LibreChat, Meilisearch, traefik route, smoke, invite)',
    async run(ctx) {
      for (const t of allTenants(ctx)) {
        await startTenant(ctx, t, { recreate: ctx.configChanged });
        await smokeTenant(ctx, t);
        // A tenant made with `pnpm tenant:create` has done this already.
        const listed = ctx.config.tenants.find((c) => c.slug === t.slug);
        if (listed) await finishTenantSetup(ctx, listed, ctx.provisioned?.[t.slug] ?? []);
      }
    },
    async rollback(ctx) {
      for (const t of allTenants(ctx)) {
        await tenantCompose(['down', '-v', '--remove-orphans'], ctx, t).catch(() => {});
      }
    },
  },
  {
    id: 'smoke',
    title: 'End-to-end smoke (models, login with MFA + final report)',
    async run(ctx) {
      for (const t of ctx.config.tenants) {
        const models = await curlBackend(ctx, '/v1/models', [
          '-H',
          `authorization: Bearer ${tenantSecret(ctx, t, 'GATEWAY_KEY')}`,
          '-H',
          'x-user-email: demo@example.com',
        ]);
        if (!models.includes('auto')) {
          throw new Error(`gateway /v1/models failed for ${t.slug}: ${models.slice(0, 200)}`);
        }
        const { out } = await runOnEdge(
          ctx,
          t,
          'oidc-smoke.mjs',
          {},
          tenantNetworkName(ctx.config, t),
        );
        await checkUsageRecorded(ctx, t, out);
        await checkToolCallPath(ctx, t);
      }
      ctx.log(
        'e2e smoke ok (models, login with MFA, chat headers, tool calls, non-member refused)',
      );
    },
  },
  {
    id: 'isolation',
    title: 'Tenant isolation checks (network, Mongo, search, gateway, Postgres, Valkey)',
    async run(ctx) {
      await checkIsolation(ctx, {
        secret: (t, name) => tenantSecret(ctx, t, name),
        gatewayStatus: async (t, email) =>
          (
            await curlBackend(ctx, '/v1/models', [
              '-o',
              '/dev/null',
              '-w',
              '%{http_code}',
              '-H',
              `authorization: Bearer ${tenantSecret(ctx, t, 'GATEWAY_KEY')}`,
              '-H',
              `x-user-email: ${email}`,
            ])
          ).trim(),
        waitForTenant: (t) =>
          waitUntil(async () => {
            const code = await curlEdge(ctx, `${t.slug}.${ctx.config.project.base_domain}`, '/');
            return ['200', '301', '302', '307', '308'].includes(code.trim());
          }),
      });
      ctx.log('tenant isolation checks passed');
    },
  },
];

/** Steps that only hold while the containers run; `dev:down` makes them pending again. */
export const SERVICE_STEPS = ['platform', 'aiplane', 'tenant', 'smoke', 'isolation'];

/** Steps a config change doesn't affect, so they stay done when re-applying. */
export const KEEP_ON_CONFIG_CHANGE = new Set(['preflight']);
