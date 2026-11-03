// SPDX-License-Identifier: AGPL-3.0-only
// katip.config.yaml: load + validate, and everything pure derived from it.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INFRA, ROOT, parseYaml } from './util.mjs';

export const CONFIG_PATH = join(ROOT, 'katip.config.yaml');
const ENV_PATH = join(INFRA, 'env', 'katip.env');

const PINNED_IMAGES = [
  'traefik',
  'postgres',
  'keycloak',
  'mongodb',
  'meilisearch',
  'valkey',
  'mailpit',
  'librechat',
  'rag_api',
  'curl',
];
const MODEL_CLASSES = ['standard', 'premium', 'tr', 'embedding'];
const MODEL_FIELDS = [
  'alias',
  'display_name',
  'class',
  'provider',
  'region',
  'data_policy',
  'price_in',
  'price_out',
  'api_key_env',
  'litellm_params',
];

/** Returns every problem found, so one run reports them all. Unknown settings are
 * errors: a setting nothing reads must not look like it does something. */
export const tenantNetworkName = (config, t) => `${config.project.name}_t_${t.slug}`;

/** Derived from the slug, so it doesn't depend on the order of the tenant list. */
export function pickTenantSubnet(config, t, used) {
  const start = createHash('sha256').update(t.slug).digest().readUInt16BE(0) % 254;
  for (let i = 0; i < 254; i += 1) {
    const subnet = `${config.project?.tenant_network_prefix}.${((start + i) % 254) + 1}.0/24`;
    if (!used.includes(subnet)) return subnet;
  }
  throw new Error(`no free tenant network left in ${config.project?.tenant_network_prefix}.0.0/16`);
}

/** What's wrong with a tenant's slug and admin email, wherever they came from. */
export function tenantInputErrors(t) {
  const errors = [];
  if (RESERVED_SLUGS.includes(t?.slug)) errors.push('slug: is reserved for the platform');
  if (!/^[a-z0-9-]{3,32}$/.test(t?.slug ?? '')) errors.push('slug: must match ^[a-z0-9-]{3,32}$');
  if (!/^[^@\s]+@[^@\s]+$/.test(t?.admin_email ?? '')) {
    errors.push('admin_email: must be an email address');
  }
  return errors;
}

export function validateConfig(c) {
  const errors = [];
  const isInt = (v) => Number.isInteger(v) && v >= 0;
  const unknown = (obj, allowed, where) => {
    for (const k of Object.keys(obj ?? {})) {
      if (!allowed.includes(k)) errors.push(`${where}.${k}: unknown setting`);
    }
  };

  unknown(c, ['project', 'identity', 'jobs', 'deploy', 'images', 'models', 'tenants'], 'config');

  unknown(
    c.project,
    ['name', 'base_domain', 'tenant_network_prefix', 'allow_mock_models'],
    'project',
  );
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.project?.name ?? '')) {
    errors.push('project.name: must match ^[a-z0-9][a-z0-9-]*$');
  }
  if (!/^[a-z0-9.-]+$/.test(c.project?.base_domain ?? '')) {
    errors.push('project.base_domain: must be a domain name');
  }

  if (!/^\d{1,3}\.\d{1,3}$/.test(c.project?.tenant_network_prefix ?? '')) {
    errors.push('project.tenant_network_prefix: must look like 10.77');
  }
  unknown(c.identity, ['realm', 'default_locale', 'locales'], 'identity');
  if (!/^[a-z0-9-]+$/.test(c.identity?.realm ?? '')) {
    errors.push('identity.realm: must match ^[a-z0-9-]+$');
  }
  if (!Array.isArray(c.identity?.locales) || c.identity.locales.length === 0) {
    errors.push('identity.locales: at least one locale is required');
  } else if (!c.identity.locales.includes(c.identity.default_locale)) {
    errors.push('identity.default_locale: must be one of identity.locales');
  }

  if (c.jobs !== undefined) {
    unknown(c.jobs, ['daily_at'], 'jobs');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(c.jobs?.daily_at ?? '')) {
      errors.push('jobs.daily_at: must be a time such as 03:30');
    }
  }

  if (c.deploy !== undefined) {
    unknown(c.deploy, ['keep_backups'], 'deploy');
    if (!Number.isInteger(c.deploy?.keep_backups) || c.deploy.keep_backups < 1) {
      errors.push('deploy.keep_backups: must be a positive integer');
    }
  }

  const images = c.images ?? {};
  unknown(images, [...PINNED_IMAGES, 'presidio_analyzer', 'litellm'], 'images');
  for (const name of PINNED_IMAGES) {
    const ref = images[name];
    if (typeof ref !== 'string' || !/:[^/:]+$/.test(ref)) {
      errors.push(`images.${name}: must be a pinned image reference (name:tag)`);
    } else if (ref.endsWith(':latest')) {
      errors.push(`images.${name}: :latest is not allowed`);
    }
  }
  const presidio = images.presidio_analyzer ?? {};
  unknown(
    presidio,
    [
      'registry',
      'version',
      'spacy_model_version',
      'spacy_model_sha256',
      'ner_model',
      'ner_model_revision',
    ],
    'images.presidio_analyzer',
  );
  for (const k of ['registry', 'version', 'spacy_model_version']) {
    if (!presidio[k]) errors.push(`images.presidio_analyzer.${k}: required`);
  }
  if (!/^[0-9a-f]{64}$/.test(presidio.spacy_model_sha256 ?? '')) {
    errors.push('images.presidio_analyzer.spacy_model_sha256: must be a sha256');
  }
  const litellm = images.litellm ?? {};
  unknown(litellm, ['version', 'sha256'], 'images.litellm');
  if (!litellm.version) errors.push('images.litellm.version: required');
  if (!/^[0-9a-f]{64}$/.test(litellm.sha256 ?? '')) {
    errors.push('images.litellm.sha256: must be a sha256');
  }

  if (!Array.isArray(c.models) || c.models.length === 0) {
    errors.push('models: at least one model is required');
  }
  if (Array.isArray(c.models) && !c.models.some((m) => m?.class === 'embedding')) {
    errors.push('models: one embedding model is required, for file search');
  }
  const aliases = new Set();
  for (const [i, m] of (Array.isArray(c.models) ? c.models : []).entries()) {
    const where = `models[${m?.alias ?? i}]`;
    unknown(m, MODEL_FIELDS, where);
    for (const k of ['alias', 'display_name', 'provider', 'region', 'data_policy', 'api_key_env']) {
      if (!m?.[k]) errors.push(`${where}.${k}: required`);
    }
    if (aliases.has(m?.alias)) errors.push(`${where}: duplicate alias`);
    aliases.add(m?.alias);
    if (!MODEL_CLASSES.includes(m?.class)) {
      errors.push(`${where}.class: must be one of ${MODEL_CLASSES.join(', ')}`);
    }
    if (!isInt(m?.price_in) || !isInt(m?.price_out)) {
      errors.push(`${where}: price_in and price_out must be integer micro-USD`);
    }
    if (!m?.litellm_params?.model) errors.push(`${where}.litellm_params.model: required`);
  }

  if (!Array.isArray(c.tenants) || c.tenants.length === 0) {
    errors.push('tenants: at least one tenant is required');
  }
  const slugs = new Set();
  for (const [i, t] of (Array.isArray(c.tenants) ? c.tenants : []).entries()) {
    const where = `tenants[${t?.slug ?? i}]`;
    unknown(
      t,
      ['slug', 'name', 'plan', 'seats', 'kvkk_addon', 'admin_email', 'limits', 'pii'],
      where,
    );
    for (const e of tenantInputErrors(t)) errors.push(`${where}.${e}`);
    if (slugs.has(t?.slug)) errors.push(`${where}: duplicate slug`);
    slugs.add(t?.slug);
    if (!t?.name) errors.push(`${where}.name: required`);
    if (!t?.plan) errors.push(`${where}.plan: required`);
    if (!Number.isInteger(t?.seats) || t.seats < 1) {
      errors.push(`${where}.seats: must be a positive integer`);
    }
    if (typeof t?.kvkk_addon !== 'boolean')
      errors.push(`${where}.kvkk_addon: must be true or false`);
    unknown(t?.limits, ['standard', 'premium'], `${where}.limits`);
    if (!isInt(t?.limits?.standard) || !isInt(t?.limits?.premium)) {
      errors.push(`${where}.limits: standard and premium must be integers`);
    }
    unknown(t?.pii, ['mode', 'on_detector_failure'], `${where}.pii`);
    if (!['off', 'mask', 'block'].includes(t?.pii?.mode)) {
      errors.push(`${where}.pii.mode: must be off, mask or block`);
    }
    if (!['allow', 'block'].includes(t?.pii?.on_detector_failure)) {
      errors.push(`${where}.pii.on_detector_failure: must be allow or block`);
    }
  }
  return errors;
}

export function loadConfig(path = CONFIG_PATH) {
  const config = parseYaml(readFileSync(path, 'utf8'));
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`invalid katip.config.yaml:\n  ${errors.join('\n  ')}`);
  }
  return config;
}

/** Values docker compose interpolates that come from the config, not katip.env. */
export function composeEnv(config) {
  const { presidio_analyzer: presidio, litellm } = config.images;
  const env = {
    KATIP_COMPOSE_PROJECT: config.project.name,
    KATIP_BASE_DOMAIN: config.project.base_domain,
    KATIP_REALM: config.identity.realm,
    LITELLM_VERSION: litellm.version,
    LITELLM_SHA256: litellm.sha256,
    KATIP_PRESIDIO_REGISTRY: presidio.registry,
    KATIP_PRESIDIO_VERSION: presidio.version,
    KATIP_SPACY_MODEL_VERSION: presidio.spacy_model_version,
    KATIP_SPACY_MODEL_SHA256: presidio.spacy_model_sha256,
    KATIP_NER_MODEL: presidio.ner_model,
    KATIP_NER_MODEL_REVISION: presidio.ner_model_revision,
  };
  for (const name of PINNED_IMAGES) env[`KATIP_IMAGE_${name.toUpperCase()}`] = config.images[name];
  return env;
}

/** The model_list entries for LiteLLM. Without its API key, a model routes to mock-llm. */
export const LOCAL_LLM_RELAY_PORT = 18090;

/** The models that would answer from the mock, because nothing real is set up for them. */
export const modelsOnMock = (config, env) =>
  config.models
    .filter(
      (m) => !env[m.api_key_env] && !(env.KATIP_LOCAL_LLM_UPSTREAM && m.class !== 'embedding'),
    )
    .map((m) => m.alias);

/**
 * The mock echoes, so someone on a real site would get nonsense and think it's the product.
 * Fine on localhost. Anywhere else it has to be asked for.
 */
export function mockModelsProblem(config, env) {
  const models = modelsOnMock(config, env);
  if (models.length === 0 || config.project.base_domain === 'localhost') return null;
  if (config.project.allow_mock_models === true) return null;
  return (
    `these models have no provider key, so they would answer from the mock: ${models.join(', ')}. ` +
    'Set their keys in infra/env/katip.env, or set project.allow_mock_models: true in the config.'
  );
}

export function renderLiteLLMModels(config, env) {
  const lines = [];
  for (const m of config.models) {
    lines.push(`  - model_name: ${m.alias}`);
    lines.push(`    litellm_params:`);
    if (env[m.api_key_env]) {
      for (const [k, v] of Object.entries(m.litellm_params)) lines.push(`      ${k}: ${v}`);
    } else if (env.KATIP_LOCAL_LLM_UPSTREAM && m.class !== 'embedding') {
      // A real model on this machine, reached through the relay (local-llm-relay.mjs).
      lines.push(`      model: openai/local`);
      lines.push(`      api_base: http://host.docker.internal:${LOCAL_LLM_RELAY_PORT}/v1`);
      lines.push(`      api_key: os.environ/LOCAL_LLM_KEY`);
    } else {
      lines.push(`      model: openai/${m.litellm_params.model}`);
      lines.push(`      api_base: http://mock-llm:8080/v1`);
      lines.push(`      api_key: os.environ/MOCK_LLM_KEY`);
    }
  }
  return lines.join('\n');
}

/**
 * The model the RAG API asks for, by id so a catalog change can't move it silently: vectors
 * from another model wouldn't compare, so changing it means embedding every file again.
 */
export const embeddingModel = (config) => config.models.find((m) => m.class === 'embedding').alias;

/** The custom endpoint's name in infra/librechat/librechat.tmpl.yaml. */
export const CHAT_ENDPOINT = 'SME AI';

/** The login smoke test's user: disabled in Keycloak between runs, the DB row stays so chat works. */
const smokeEmail = (config, t) => `smoke-member@${t.slug}.${config.project.base_domain}`;

/** Per-tenant secrets, generated once into katip.env. */
export const TENANT_SECRETS = [
  'GATEWAY_KEY',
  'LC_CREDS_KEY',
  'LC_CREDS_IV',
  'LC_JWT_SECRET',
  'LC_JWT_REFRESH_SECRET',
  'LC_OIDC_CLIENT_SECRET',
  'LC_OIDC_SESSION_SECRET',
  'MONGO_PASSWORD',
  'MEILI_KEY',
  'RAG_DB_PASSWORD',
  'RAG_GATEWAY_KEY',
  'DEMO_USER_PASSWORD',
];

export const tenantSecretName = (slug, name) =>
  `KATIP_T_${slug.toUpperCase().replace(/-/g, '_')}_${name}`;

/** Hostnames the platform uses: a tenant called this would take over its route. */
export const RESERVED_SLUGS = ['auth', 'console', 'mailpit', 'provider', 'www', 'api', 'admin'];

/** Input for the provisioner. `t` may come from the config or from `pnpm tenant:create`. */
export const provisionInput = (config, t) => ({
  slug: t.slug,
  name: t.name,
  planCode: t.plan,
  seats: t.seats,
  region: t.region ?? 'eu',
  kvkkAddon: t.kvkk_addon,
  adminEmail: t.admin_email,
  baseDomain: config.project.base_domain,
});

/** Input for scripts/setup/keycloak.mjs: what all tenants share. */
export const platformIdentityInput = (config) => ({
  realm: config.identity.realm,
  locales: config.identity.locales,
  defaultLocale: config.identity.default_locale,
  baseDomain: config.project.base_domain,
  consoleOrigin: `https://console.${config.project.base_domain}`,
});

/** Input for scripts/setup/db-seed.mjs, which runs inside the gateway image. */
export function seedInput(config) {
  return {
    tenants: config.tenants.map((t) => ({
      tenant: {
        slug: t.slug,
        name: t.name,
        planCode: t.plan,
        seats: t.seats,
        kvkkAddon: t.kvkk_addon,
      },
      limits: t.limits,
      smokeEmail: smokeEmail(config, t),
      pii: { mode: t.pii.mode, onDetectorFailure: t.pii.on_detector_failure },
    })),
    models: config.models.map((m) => ({
      id: m.alias,
      litellmName: m.alias,
      displayName: m.display_name,
      class: m.class,
      provider: m.provider,
      region: m.region,
      dataPolicy: m.data_policy,
      priceInUsdMicroPerM: m.price_in,
      priceOutUsdMicroPerM: m.price_out,
    })),
  };
}

/** Input for scripts/setup/keycloak.mjs and oidc-smoke.mjs. Users match the DB seed. */
export function identityInput(config, t) {
  const { slug, name } = t;
  const others = config.tenants.filter((o) => o.slug !== slug);
  const origin = `https://${slug}.${config.project.base_domain}`;
  const demoUser = (local, firstName, realmRole) => ({
    email: `${local}@${slug}.localhost`,
    firstName,
    lastName: 'Demo',
    realmRole,
  });
  return {
    realm: config.identity.realm,
    baseDomain: config.project.base_domain,
    consoleOrigin: `https://console.${config.project.base_domain}`,
    tenant: { slug, name },
    smokeEmail: smokeEmail(config, t),
    chatEndpoint: CHAT_ENDPOINT,
    otherClientId: others.length > 0 ? `lc-${others[0].slug}` : null,
    client: { id: `lc-${slug}`, origin, redirectUri: `${origin}/oauth/openid/callback` },
    users: [
      demoUser('admin', 'Admin', 'tenant_admin'),
      demoUser('manager', 'Manager', 'dept_manager'),
      demoUser('user', 'User', 'user'),
    ],
  };
}

/** Hash of what the rendered output depends on; a change means re-apply. */
export function configHash(configPath = CONFIG_PATH, envPath = ENV_PATH) {
  const h = createHash('sha256').update(readFileSync(configPath));
  if (existsSync(envPath)) h.update(readFileSync(envPath));
  return h.digest('hex');
}

export const identityOf = (config) => ({
  project: config.project.name,
  slugs: config.tenants.map((t) => t.slug),
});
