// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composeEnv,
  identityInput,
  loadConfig,
  renderLiteLLMModels,
  seedInput,
  validateConfig,
} from '../config.mjs';
import { totp } from '../kc-lib.mjs';
import { INFRA, generatorFor, parseEnvFile, parseYaml, redact } from '../util.mjs';

const config = loadConfig();
const clone = () => structuredClone(config);
const read = (...p) => readFileSync(join(INFRA, ...p), 'utf8');
const COMPOSE_FILES = [
  ['compose', 'platform.yml'],
  ['compose', 'dev.yml'],
];

describe('validateConfig', () => {
  it('accepts the checked-in config', () => {
    expect(validateConfig(config)).toEqual([]);
  });

  it('rejects settings nothing reads', () => {
    const c = { ...clone(), services: { keycloak: { realm: 'katip' } } };
    expect(validateConfig(c)).toContain('config.services: unknown setting');
    const t = clone();
    t.tenant.region = 'eu';
    expect(validateConfig(t)).toContain('tenant.region: unknown setting');
  });

  it('rejects unpinned images', () => {
    const c = clone();
    c.images.traefik = 'traefik:latest';
    c.images.valkey = 'valkey/valkey';
    const errors = validateConfig(c);
    expect(errors).toContain('images.traefik: :latest is not allowed');
    expect(errors).toContain('images.valkey: must be a pinned image reference (name:tag)');
  });

  it('accepts a registry port without treating it as a tag', () => {
    const c = clone();
    c.images.valkey = 'registry.local:5000/valkey';
    expect(validateConfig(c)).toContain(
      'images.valkey: must be a pinned image reference (name:tag)',
    );
    c.images.valkey = 'registry.local:5000/valkey:8.0.12';
    expect(validateConfig(c)).toEqual([]);
  });

  it('rejects a bad slug, duplicate aliases and bad policy values', () => {
    const c = clone();
    c.tenant.slug = 'No';
    c.tenant.pii.on_detector_failure = 'maybe';
    c.models[1].alias = c.models[0].alias;
    const errors = validateConfig(c);
    expect(errors).toContain('tenant.slug: must match ^[a-z0-9-]{3,32}$');
    expect(errors).toContain('tenant.pii.on_detector_failure: must be allow or block');
    expect(errors.some((e) => e.includes('duplicate alias'))).toBe(true);
  });
});

describe('compose files derive from the config', () => {
  it('pins no image version themselves', () => {
    for (const f of COMPOSE_FILES) {
      for (const line of read(...f).split('\n')) {
        if (!/^\s+image:/.test(line)) continue;
        expect(line.includes('${') || line.includes('ghcr.io/krugis/')).toBe(true);
      }
    }
  });

  it('only use variables the config or katip.env provide', () => {
    const provided = new Set([
      ...Object.keys(composeEnv(config)),
      ...Object.keys(parseEnvFile(read('env', 'katip.example.env'))),
    ]);
    for (const f of COMPOSE_FILES) {
      for (const [, name] of read(...f).matchAll(/\$\{([A-Z0-9_]+)(?::?[-?][^}]*)?\}/g)) {
        expect(provided, `${f.join('/')} uses ${name}`).toContain(name);
      }
    }
  });

  it('pass every model key to the LiteLLM container', () => {
    const dev = read('compose', 'dev.yml');
    for (const m of config.models) expect(dev).toContain(`${m.api_key_env}: \${`);
    expect(dev).toContain('GCP_PROJECT: ${');
  });

  it('expose an image variable for every pinned image', () => {
    const env = composeEnv(config);
    expect(env.KATIP_IMAGE_TRAEFIK).toBe(config.images.traefik);
    expect(env.KATIP_COMPOSE_PROJECT).toBe(config.project.name);
    expect(env.KATIP_PRESIDIO_VERSION).toBe(config.images.presidio_analyzer.version);
  });
});

describe('renderLiteLLMModels', () => {
  it('routes a model without its key to the mock', () => {
    const out = renderLiteLLMModels(config, {});
    expect(out).toContain('api_base: http://mock-llm:8080/v1');
    expect(out).not.toContain('os.environ/ANTHROPIC_API_KEY');
  });

  it('uses the real provider params once the key is set, and never the key itself', () => {
    const out = renderLiteLLMModels(config, { GCP_VERTEX_KEY: 'x', ANTHROPIC_API_KEY: 'sekret' });
    expect(out).toContain('api_key: os.environ/ANTHROPIC_API_KEY');
    expect(out).toContain('vertex_location: europe-west3');
    expect(out).not.toContain('sekret');
  });
});

describe('identity', () => {
  it('rejects an invalid realm and a default locale that is not offered', () => {
    const c = clone();
    c.identity.realm = 'Not Valid';
    c.identity.default_locale = 'de';
    const errors = validateConfig(c);
    expect(errors).toContain('identity.realm: must match ^[a-z0-9-]+$');
    expect(errors).toContain('identity.default_locale: must be one of identity.locales');
  });

  it('derives the client and redirect URI from the tenant and domain', () => {
    const c = clone();
    c.tenant.slug = 'acme';
    c.project.base_domain = 'example.test';
    const i = identityInput(c);
    expect(i.client).toEqual({
      id: 'lc-acme',
      origin: 'https://acme.example.test',
      redirectUri: 'https://acme.example.test/oauth/openid/callback',
    });
    expect(i.users.map((u) => u.email)).toContain('admin@acme.localhost');
  });

  it('renders OIDC settings into the tenant env template only as variables', () => {
    const tmpl = read('env', 'tenant.example.env');
    expect(tmpl).toContain('OPENID_CLIENT_SECRET=${KATIP_LC_OIDC_CLIENT_SECRET}');
    expect(tmpl).toContain('ALLOW_EMAIL_LOGIN=false');
  });

  it('makes LibreChat wait for the issuer before it starts', () => {
    expect(read('compose', 'tenant.tmpl.yml')).toContain('.well-known/openid-configuration');
  });

  it('computes TOTP per the RFC 6238 test vector', () => {
    expect(totp('12345678901234567890', 59_000, 8)).toBe('94287082');
    expect(totp('12345678901234567890', 59_000)).toBe('287082');
  });
});

describe('seedInput', () => {
  it('covers every model and tenant setting', () => {
    const s = seedInput(config);
    expect(s.models.map((m) => m.id)).toEqual(config.models.map((m) => m.alias));
    expect(s.models[0]).toMatchObject({ priceInUsdMicroPerM: config.models[0].price_in });
    expect(s.tenant).toMatchObject({ slug: config.tenant.slug, seats: config.tenant.seats });
    expect(s.pii.onDetectorFailure).toBe(config.tenant.pii.on_detector_failure);
  });
});

describe('util', () => {
  it('parseEnvFile treats a comment-only value as empty', () => {
    expect(parseEnvFile('VLLM_TR_KEY=      # phase-3 only\nA=b # note\nC=')).toEqual({
      VLLM_TR_KEY: '',
      A: 'b',
      C: '',
    });
  });

  it('parseYaml keeps nested params and strips comments', () => {
    const y = parseYaml('models:\n  - alias: a\n    p:\n      model: x/y # (verify)\n      n: 3\n');
    expect(y).toEqual({ models: [{ alias: 'a', p: { model: 'x/y', n: 3 } }] });
  });

  it('generates LibreChat credentials in the hex format it requires', () => {
    expect(generatorFor('KATIP_LC_CREDS_KEY')()).toMatch(/^[0-9a-f]{64}$/);
    expect(generatorFor('KATIP_LC_CREDS_IV')()).toMatch(/^[0-9a-f]{32}$/);
    expect(generatorFor('KATIP_DEMO_GATEWAY_KEY')()).toMatch(/^sk-sme-t-/);
    expect(generatorFor('POSTGRES_PASSWORD')()).toMatch(/^[\w-]{43}$/);
  });

  it('redact hides bearer tokens in command errors', () => {
    expect(redact('curl -H authorization: Bearer sk-abc123 -d x')).toBe(
      'curl -H authorization: Bearer *** -d x',
    );
  });
});
