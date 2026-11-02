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
export function validateConfig(c) {
  const errors = [];
  const isInt = (v) => Number.isInteger(v) && v >= 0;
  const unknown = (obj, allowed, where) => {
    for (const k of Object.keys(obj ?? {})) {
      if (!allowed.includes(k)) errors.push(`${where}.${k}: unknown setting`);
    }
  };

  unknown(c, ['project', 'identity', 'images', 'models', 'tenant'], 'config');

  unknown(c.project, ['name', 'base_domain'], 'project');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(c.project?.name ?? '')) {
    errors.push('project.name: must match ^[a-z0-9][a-z0-9-]*$');
  }
  if (!/^[a-z0-9.-]+$/.test(c.project?.base_domain ?? '')) {
    errors.push('project.base_domain: must be a domain name');
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
    ['registry', 'version', 'spacy_model_version', 'spacy_model_sha256'],
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

  const t = c.tenant ?? {};
  unknown(t, ['slug', 'name', 'plan', 'seats', 'kvkk_addon', 'limits', 'pii'], 'tenant');
  if (!/^[a-z0-9-]{3,32}$/.test(t.slug ?? '')) {
    errors.push('tenant.slug: must match ^[a-z0-9-]{3,32}$');
  }
  if (!t.name) errors.push('tenant.name: required');
  if (!t.plan) errors.push('tenant.plan: required');
  if (!Number.isInteger(t.seats) || t.seats < 1) {
    errors.push('tenant.seats: must be a positive integer');
  }
  if (typeof t.kvkk_addon !== 'boolean') errors.push('tenant.kvkk_addon: must be true or false');
  unknown(t.limits, ['standard', 'premium'], 'tenant.limits');
  if (!isInt(t.limits?.standard) || !isInt(t.limits?.premium)) {
    errors.push('tenant.limits: standard and premium must be integers');
  }
  unknown(t.pii, ['mode', 'on_detector_failure'], 'tenant.pii');
  if (!['off', 'mask', 'block'].includes(t.pii?.mode)) {
    errors.push('tenant.pii.mode: must be off, mask or block');
  }
  if (!['allow', 'block'].includes(t.pii?.on_detector_failure)) {
    errors.push('tenant.pii.on_detector_failure: must be allow or block');
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
    KATIP_TENANT_SLUG: config.tenant.slug,
    LITELLM_VERSION: litellm.version,
    LITELLM_SHA256: litellm.sha256,
    KATIP_PRESIDIO_REGISTRY: presidio.registry,
    KATIP_PRESIDIO_VERSION: presidio.version,
    KATIP_SPACY_MODEL_VERSION: presidio.spacy_model_version,
    KATIP_SPACY_MODEL_SHA256: presidio.spacy_model_sha256,
  };
  for (const name of PINNED_IMAGES) env[`KATIP_IMAGE_${name.toUpperCase()}`] = config.images[name];
  return env;
}

/** The model_list entries for LiteLLM. Without its API key, a model routes to mock-llm. */
export function renderLiteLLMModels(config, env) {
  const lines = [];
  for (const m of config.models) {
    lines.push(`  - model_name: ${m.alias}`);
    lines.push(`    litellm_params:`);
    if (env[m.api_key_env]) {
      for (const [k, v] of Object.entries(m.litellm_params)) lines.push(`      ${k}: ${v}`);
    } else {
      lines.push(`      model: openai/${m.litellm_params.model}`);
      lines.push(`      api_base: http://mock-llm:8080/v1`);
      lines.push(`      api_key: os.environ/MOCK_LLM_KEY`);
    }
  }
  return lines.join('\n');
}

/** Input for scripts/setup/db-seed.mjs, which runs inside the gateway image. */
export function seedInput(config) {
  const t = config.tenant;
  return {
    tenant: {
      slug: t.slug,
      name: t.name,
      planCode: t.plan,
      seats: t.seats,
      kvkkAddon: t.kvkk_addon,
    },
    limits: t.limits,
    pii: { mode: t.pii.mode, onDetectorFailure: t.pii.on_detector_failure },
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
export function identityInput(config) {
  const { slug, name } = config.tenant;
  const origin = `https://${slug}.${config.project.base_domain}`;
  const demoUser = (local, firstName, realmRole) => ({
    email: `${local}@${slug}.localhost`,
    firstName,
    lastName: 'Demo',
    realmRole,
  });
  return {
    realm: config.identity.realm,
    locales: config.identity.locales,
    defaultLocale: config.identity.default_locale,
    baseDomain: config.project.base_domain,
    tenant: { slug, name },
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
  slug: config.tenant.slug,
});
