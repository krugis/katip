// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_ENDPOINT,
  composeEnv,
  embeddingModel,
  identityInput,
  loadConfig,
  renderLiteLLMModels,
  seedInput,
  tenantSecretName,
  pickTenantSubnet,
  validateConfig,
} from '../config.mjs';
import {
  adoptTenantSecretsFromEnvFile,
  ensureTenantSecrets,
  knownTenantSlugs,
  tenantSecretsFile,
} from '../tenants.mjs';
import { tenantPairs } from '../isolation.mjs';
import { totp } from '../kc-lib.mjs';
import { renderTenantFiles } from '../steps.mjs';
import { FORGET_VECTORS_SQL } from '../tenant-lifecycle.mjs';
import { INFRA, generatorFor, parseEnvFile, parseYaml, redact, run } from '../util.mjs';

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
    t.tenants[0].region = 'eu';
    expect(validateConfig(t)).toContain('tenants[demo].region: unknown setting');
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
    c.tenants[0].slug = 'No';
    c.tenants[0].pii.on_detector_failure = 'maybe';
    c.models[1].alias = c.models[0].alias;
    const errors = validateConfig(c);
    expect(errors).toContain('tenants[No].slug: must match ^[a-z0-9-]{3,32}$');
    expect(errors).toContain('tenants[No].pii.on_detector_failure: must be allow or block');
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
    c.project.base_domain = 'example.test';
    const i = identityInput(c, { slug: 'acme', name: 'Acme' });
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

  it('uses the same chat endpoint name in the smoke test and LibreChat config', () => {
    const tmpl = read('librechat', 'librechat.tmpl.yaml');
    expect(tmpl).toContain(`- name: ${CHAT_ENDPOINT}`);
    expect(tmpl).toContain("X-User-Email: '{{LIBRECHAT_USER_EMAIL}}'");
    expect(identityInput(config, config.tenants[0]).chatEndpoint).toBe(CHAT_ENDPOINT);
  });

  it('gives the DB and Keycloak the same smoke user', () => {
    for (const [i, t] of config.tenants.entries()) {
      expect(seedInput(config).tenants[i].smokeEmail).toBe(identityInput(config, t).smokeEmail);
    }
  });

  it('makes LibreChat wait for the issuer before it starts', () => {
    expect(read('compose', 'tenant.tmpl.yml')).toContain('.well-known/openid-configuration');
  });

  it('computes TOTP per the RFC 6238 test vector', () => {
    expect(totp('12345678901234567890', 59_000, 8)).toBe('94287082');
    expect(totp('12345678901234567890', 59_000)).toBe('287082');
  });
});

describe('tenants', () => {
  it('checks each tenant against another, in both directions', () => {
    const [a, b] = config.tenants;
    expect(tenantPairs([a, b])).toEqual([
      [a, b],
      [b, a],
    ]);
    expect(tenantPairs([a])).toEqual([]);
    expect(identityInput(config, a).otherClientId).toBe(`lc-${b.slug}`);
  });

  it('runs at least two in dev, so isolation is tested on every install', () => {
    expect(new Set(config.tenants.map((t) => t.slug)).size).toBeGreaterThanOrEqual(2);
  });

  it('rejects duplicate slugs', () => {
    const c = clone();
    c.tenants[1].slug = c.tenants[0].slug;
    expect(validateConfig(c)).toContain('tenants[demo]: duplicate slug');
  });

  it('names secrets per tenant, so tenants never share one', () => {
    expect(tenantSecretName('demo', 'LC_CREDS_KEY')).toBe('KATIP_T_DEMO_LC_CREDS_KEY');
    expect(tenantSecretName('a-b', 'MEILI_KEY')).toBe('KATIP_T_A_B_MEILI_KEY');
  });

  it('refuses a slug the platform uses, and a missing admin email', () => {
    const c = clone();
    c.tenants[0].slug = 'console';
    c.tenants[1].admin_email = 'nope';
    const errors = validateConfig(c);
    expect(errors).toContain('tenants[console].slug: is reserved for the platform');
    expect(errors).toContain('tenants[acme].admin_email: must be an email address');
  });

  it('keeps tenant secrets in a private file, stable across calls', () => {
    const infra = mkdtempSync(join(tmpdir(), 'katip-secrets-'));
    try {
      const first = ensureTenantSecrets(infra, 'acme');
      expect(first.KATIP_T_ACME_LC_CREDS_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(first.KATIP_T_ACME_GATEWAY_KEY).toMatch(/^sk-sme-t-/);
      expect(ensureTenantSecrets(infra, 'acme')).toEqual(first);
      expect(knownTenantSlugs(infra)).toEqual(['acme']);
      const file = tenantSecretsFile(infra, 'acme');
      expect(statSync(file).mode & 0o077).toBe(0);
      const other = ensureTenantSecrets(infra, 'beta');
      expect(other.KATIP_T_BETA_GATEWAY_KEY).not.toBe(first.KATIP_T_ACME_GATEWAY_KEY);
      expect(knownTenantSlugs(infra)).toEqual(['acme', 'beta']);
    } finally {
      rmSync(infra, { recursive: true, force: true });
    }
  });

  it('moves secrets out of katip.env with their values, once', () => {
    const infra = mkdtempSync(join(tmpdir(), 'katip-secrets-'));
    try {
      mkdirSync(join(infra, 'env'));
      writeFileSync(
        join(infra, 'env', 'katip.env'),
        'POSTGRES_PASSWORD=x\nKATIP_T_A_B_DEMO_USER_PASSWORD=kept\nKATIP_T_DEMO_DEMO_USER_PASSWORD=also\n',
      );
      adoptTenantSecretsFromEnvFile(infra);
      expect(knownTenantSlugs(infra)).toEqual(['a-b', 'demo']);
      expect(ensureTenantSecrets(infra, 'a-b').KATIP_T_A_B_DEMO_USER_PASSWORD).toBe('kept');
      expect(ensureTenantSecrets(infra, 'demo').KATIP_T_DEMO_DEMO_USER_PASSWORD).toBe('also');
      expect(statSync(tenantSecretsFile(infra, 'a-b')).mode & 0o077).toBe(0);
      const generated = ensureTenantSecrets(infra, 'a-b').KATIP_T_A_B_MEILI_KEY;
      adoptTenantSecretsFromEnvFile(infra);
      expect(ensureTenantSecrets(infra, 'a-b').KATIP_T_A_B_MEILI_KEY).toBe(generated);
    } finally {
      rmSync(infra, { recursive: true, force: true });
    }
  });

  it('adds a secret that is missing, without touching the others', () => {
    const infra = mkdtempSync(join(tmpdir(), 'katip-secrets-'));
    try {
      const first = ensureTenantSecrets(infra, 'acme');
      const file = tenantSecretsFile(infra, 'acme');
      const kept = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.startsWith('KATIP_T_ACME_MEILI_KEY='))
        .join('\n');
      writeFileSync(file, kept);
      const second = ensureTenantSecrets(infra, 'acme');
      expect(second.KATIP_T_ACME_GATEWAY_KEY).toBe(first.KATIP_T_ACME_GATEWAY_KEY);
      expect(second.KATIP_T_ACME_MEILI_KEY).toBeTruthy();
    } finally {
      rmSync(infra, { recursive: true, force: true });
    }
  });

  it('generates each secret in the format it needs', () => {
    expect(generatorFor('KATIP_T_ACME_LC_CREDS_KEY')()).toMatch(/^[0-9a-f]{64}$/);
    expect(generatorFor('KATIP_T_ACME_LC_CREDS_IV')()).toMatch(/^[0-9a-f]{32}$/);
    expect(generatorFor('KATIP_T_ACME_GATEWAY_KEY')()).toMatch(/^sk-sme-t-/);
  });

  it('starts each subnet from the slug, and steps past ones in use', () => {
    const [a] = config.tenants;
    const first = pickTenantSubnet(config, a, []);
    expect(first).toMatch(/^10\.77\.\d+\.0\/24$/);
    const second = pickTenantSubnet(config, a, [first]);
    expect(second).not.toBe(first);
    expect(pickTenantSubnet(config, a, [])).toBe(first);
    const all = Array.from({ length: 254 }, (_, i) => `10.77.${i + 1}.0/24`);
    expect(() => pickTenantSubnet(config, a, all)).toThrow(/no free tenant network/);
    expect(pickTenantSubnet(config, a, all.slice(1))).toBe('10.77.1.0/24');
  });

  it('prefers a real key, then a local model, then the mock', () => {
    const local = renderLiteLLMModels(config, { KATIP_LOCAL_LLM_UPSTREAM: '127.0.0.1:8080' });
    expect(local).toContain('api_base: http://host.docker.internal:18090/v1');
    // A local chat model says nothing about embeddings, so those stay on the mock.
    const embedding = config.models.find((m) => m.class === 'embedding').alias;
    for (const block of local.split('  - model_name: ').slice(1)) {
      expect(block.includes('mock-llm')).toBe(block.startsWith(embedding));
    }
    const mock = renderLiteLLMModels(config, {});
    expect(mock).toContain('mock-llm');
    expect(mock).not.toContain('host.docker.internal');
    const key = renderLiteLLMModels(config, {
      KATIP_LOCAL_LLM_UPSTREAM: '127.0.0.1:8080',
      DEEPINFRA_API_KEY: 'k',
    });
    expect(key).toContain('deepinfra/deepseek-ai/DeepSeek-V4-Flash');
  });

  it('keeps LibreChat off the shared networks', () => {
    const compose = read('compose', 'tenant.tmpl.yml');
    expect(compose).not.toMatch(/^\s+- (edge|backend)$/m);
    expect(compose).toContain('traefik.docker.network=${KATIP_COMPOSE_PROJECT}_t_${KATIP_SLUG}');
  });

  it('protects Valkey with a password', () => {
    expect(read('compose', 'platform.yml')).toContain('--requirepass');
    expect(read('compose', 'platform.yml')).toContain('grep -q PONG');
    expect(read('compose', 'dev.yml')).toContain('redis://:${VALKEY_PASSWORD');
  });

  it('gives each tenant its own search and a Mongo login scoped to its database', () => {
    const compose = read('compose', 'tenant.tmpl.yml');
    expect(compose).toContain('meili-${KATIP_SLUG}:');
    const env = read('env', 'tenant.example.env');
    expect(env).toContain('MEILI_HOST=http://meili-${KATIP_SLUG}:7700');
    expect(env).toContain('authSource=lc_${KATIP_SLUG}');
    expect(env).not.toContain('authSource=admin');
    expect(read('compose', 'platform.yml')).not.toContain('meilisearch');
  });
});

describe('file search', () => {
  const rendered = (slug = 'acme') => {
    const infra = mkdtempSync(join(tmpdir(), 'katip-render-'));
    for (const [dir, file] of [
      ['env', 'tenant.example.env'],
      ['env', 'tenant.rag.example.env'],
      ['librechat', 'librechat.tmpl.yaml'],
      ['compose', 'tenant.tmpl.yml'],
    ]) {
      mkdirSync(join(infra, dir), { recursive: true });
      writeFileSync(join(infra, dir, file), read(dir, file));
    }
    const env = { ...ensureTenantSecrets(infra, slug), ...ensureTenantSecrets(infra, 'beta') };
    renderTenantFiles({ config, infra, env }, { slug });
    const out = (...p) => readFileSync(join(infra, ...p), 'utf8');
    return {
      infra,
      env,
      compose: out('compose', 'tenants', `${slug}.yml`),
      lc: parseEnvFile(out('env', 'tenants', `${slug}.env`)),
      rag: parseEnvFile(out('env', 'tenants', `${slug}.rag.env`)),
      ragFile: out('env', 'tenants', `${slug}.rag.env`),
      ragdb: out('env', 'tenants', `${slug}.ragdb.env`),
    };
  };
  const withRendered = (fn) => {
    const r = rendered();
    try {
      fn(r);
    } finally {
      rmSync(r.infra, { recursive: true, force: true });
    }
  };

  it('pins the RAG API, and refuses a config without a model for it', () => {
    expect(config.images.rag_api).toMatch(/:v\d+\.\d+\.\d+$/);
    expect(composeEnv(config).KATIP_IMAGE_RAG_API).toBe(config.images.rag_api);
    const c = clone();
    c.images.rag_api = 'ghcr.io/danny-avila/librechat-rag-api-dev-lite:latest';
    c.models = c.models.filter((m) => m.class !== 'embedding');
    const errors = validateConfig(c);
    expect(errors).toContain('images.rag_api: :latest is not allowed');
    expect(errors).toContain('models: one embedding model is required, for file search');
  });

  it("gives each tenant its own, on that tenant's network only", () => {
    withRendered(({ compose }) => {
      expect(compose).toContain(`image: ${config.images.rag_api}`);
      expect(compose).toContain(`image: ${config.images.postgres}`);
      expect(compose).toContain('  rag-acme:');
      expect(compose).toContain('  ragdb-acme:');
      expect(compose).toContain('ragdb-acme:/var/lib/postgresql/data');
      expect(compose).toMatch(/^volumes:[\s\S]*^ {2}ragdb-acme: \{\}$/m);
      expect(compose).not.toMatch(/^\s+- (edge|backend)$/m);
      expect(compose).not.toMatch(/^\s+ports:/m);
      expect(compose).not.toContain('${KATIP_IMAGE');
      expect(compose).not.toContain('${KATIP_SLUG');
      expect(compose).not.toContain('traefik.http.routers.rag');
    });
  });

  it('points LibreChat at its own RAG API, which trusts only that LibreChat', () => {
    withRendered(({ lc, rag, env }) => {
      expect(lc.RAG_API_URL).toBe('http://rag-acme:8000');
      expect(rag.JWT_SECRET).toBe(lc.JWT_SECRET);
      expect(rag.JWT_SECRET).toBe(env.KATIP_T_ACME_LC_JWT_SECRET);
      expect(rag.JWT_SECRET).not.toBe(env.KATIP_T_BETA_LC_JWT_SECRET);
      expect(rag.DB_HOST).toBe('ragdb-acme');
    });
  });

  it('embeds through the gateway, on its own key, sending text', () => {
    withRendered(({ rag, env, ragFile }) => {
      expect(rag.RAG_OPENAI_BASEURL).toBe('http://policy-gateway:8080/v1');
      expect(rag.RAG_OPENAI_API_KEY).toBe(env.KATIP_T_ACME_RAG_GATEWAY_KEY);
      expect(rag.RAG_OPENAI_API_KEY).toMatch(/^sk-sme-t-/);
      expect(rag.RAG_OPENAI_API_KEY).not.toBe(env.KATIP_T_ACME_GATEWAY_KEY);
      expect(rag.EMBEDDINGS_MODEL).toBe(embeddingModel(config));
      expect(rag.EMBEDDINGS_MODEL).toBe('emb-bge-m3');
      // Otherwise it sends token ids, which the gateway refuses.
      expect(rag.RAG_CHECK_EMBEDDING_CTX_LENGTH).toBe('False');
      expect(rag.PARALLEL_EXECUTION).toBe('1');
      expect(ragFile).not.toContain('${');
    });
  });

  it('keeps the secrets private and the database password apart', () => {
    withRendered(({ infra, rag, ragdb, env }) => {
      expect(ragdb).toBe(`POSTGRES_PASSWORD=${env.KATIP_T_ACME_RAG_DB_PASSWORD}\n`);
      expect(rag.POSTGRES_PASSWORD).toBe(env.KATIP_T_ACME_RAG_DB_PASSWORD);
      expect(env.KATIP_T_ACME_RAG_DB_PASSWORD).not.toBe(env.KATIP_T_BETA_RAG_DB_PASSWORD);
      for (const f of ['acme.rag.env', 'acme.ragdb.env']) {
        expect(statSync(join(infra, 'env', 'tenants', f)).mode & 0o077).toBe(0);
      }
    });
  });

  it('removes vectors by owner and by file, with values passed apart from the statement', () => {
    expect(FORGET_VECTORS_SQL).toContain(`cmetadata->>'user_id' = :'who'`);
    expect(FORGET_VECTORS_SQL).toContain(`cmetadata->>'file_id' IN`);
    expect(FORGET_VECTORS_SQL).toContain('VACUUM');
  });
});

describe('console-api', () => {
  it('connects as the role row-level security binds, not the admin one', () => {
    const dev = read('compose', 'dev.yml');
    expect(dev).toContain('postgres://katip_console:${KATIP_CONSOLE_DB_PASSWORD');
  });
});

describe('seedInput', () => {
  it('covers every model and tenant setting', () => {
    const s = seedInput(config);
    expect(s.models.map((m) => m.id)).toEqual(config.models.map((m) => m.alias));
    expect(s.models[0]).toMatchObject({ priceInUsdMicroPerM: config.models[0].price_in });
    const t = config.tenants[0];
    expect(s.tenants[0].tenant).toMatchObject({ slug: t.slug, seats: t.seats });
    expect(s.tenants[0].pii.onDetectorFailure).toBe(t.pii.on_detector_failure);
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
    expect(generatorFor('KATIP_T_DEMO_LC_CREDS_KEY')()).toMatch(/^[0-9a-f]{64}$/);
    expect(generatorFor('KATIP_T_DEMO_LC_CREDS_IV')()).toMatch(/^[0-9a-f]{32}$/);
    expect(generatorFor('KATIP_T_DEMO_GATEWAY_KEY')()).toMatch(/^sk-sme-t-/);
    expect(generatorFor('POSTGRES_PASSWORD')()).toMatch(/^[\w-]{43}$/);
  });

  it('run stops a command that exceeds its time limit', async () => {
    await expect(run('sleep', ['5'], { timeoutMs: 100 })).rejects.toMatchObject({
      name: 'TimedOut',
    });
    await expect(run('true', [], { timeoutMs: 5000 })).resolves.toMatchObject({ code: 0 });
  });

  it('redact hides bearer tokens in command errors', () => {
    expect(redact('curl -H authorization: Bearer sk-abc123 -d x')).toBe(
      'curl -H authorization: Bearer *** -d x',
    );
  });
});
