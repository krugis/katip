// SPDX-License-Identifier: AGPL-3.0-only
// POST /v1/embeddings (tracker P1-08, LLD-03 §1): what leaves for a provider, and what's counted.
import { buildMockApp } from '@katip/mock-llm';
import { DEFAULT_CATALOG, DEFAULT_POLICY, type ModelEntry } from '@katip/policy-engine';
import type { Span } from '@katip/pii';
import { createLogger } from '@katip/shared';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@katip/shared/tracing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/app.js';
import { GatewayMetrics } from '../src/metrics.js';
import {
  MemoryQuotaStore,
  MemoryTenantStore,
  MemoryUsageSink,
  NO_PERSON,
  type Tenant,
} from '../src/stores.js';

const KEY = 'sk-katip-acme-test';
const SERVICE_KEY = 'sk-katip-acme-rag';
const BETA_KEY = 'sk-katip-beta-test';
const EMAIL = 'ayse@acme.com.tr';
const TCKN = '10000000146';
const IBAN = 'TR33 0006 1005 1978 6457 8413 26';
const SECRET_WORD = 'GizliKelime73';

const acme = (over: Partial<Tenant> = {}): Tenant => ({
  id: 't-acme',
  slug: 'acme',
  status: 'active',
  policy: { ...DEFAULT_POLICY },
  pii: { mode: 'mask' },
  kvkkAddon: false,
  limits: { standard: 1_000_000, premium: 100_000 },
  ...over,
});

const NAME_DETECTOR = async (text: string): Promise<Span[]> =>
  [...text.matchAll(/Ahmet Yılmaz/g)].map((m) => ({
    type: 'PERSON' as const,
    start: m.index,
    end: m.index + m[0].length,
    value: m[0],
    score: 0.9,
  }));

let mock: ReturnType<typeof buildMockApp>;
let mockUrl: string;
let gw: FastifyInstance;
let usage: MemoryUsageSink;
let quota: MemoryQuotaStore;
let metrics: GatewayMetrics;
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('test');

function build(t: Tenant = acme(), extra: Partial<Parameters<typeof buildGateway>[0]> = {}) {
  const tenants = new MemoryTenantStore();
  tenants.addTenant(t, [KEY]);
  tenants.addTenant({ ...t, serviceKey: true }, [SERVICE_KEY]);
  tenants.addUser({ id: 'u-1', tenantId: t.id, email: EMAIL, status: 'active' });
  tenants.addUser({ id: 'u-2', tenantId: t.id, email: 'off@acme.com.tr', status: 'disabled' });
  const beta = acme({ id: 't-beta', slug: 'beta' });
  tenants.addTenant(beta, [BETA_KEY]);
  tenants.addUser({ id: 'u-9', tenantId: beta.id, email: 'can@beta.com.tr', status: 'active' });
  usage = new MemoryUsageSink();
  quota = new MemoryQuotaStore();
  metrics = new GatewayMetrics();
  gw = buildGateway({
    litellmBaseUrl: mockUrl,
    litellmApiKey: 'test',
    tenants,
    quota,
    usage,
    metrics,
    tracer,
    logger: createLogger('test', { level: 'silent' }),
    ...extra,
  });
}

const embed = (payload: object, headers: Record<string, string> = {}) =>
  gw.inject({
    method: 'POST',
    url: '/v1/embeddings',
    headers: { authorization: `Bearer ${KEY}`, 'x-user-email': EMAIL, ...headers },
    payload,
  });
const asService = (payload: object) =>
  gw.inject({
    method: 'POST',
    url: '/v1/embeddings',
    headers: { authorization: `Bearer ${SERVICE_KEY}` },
    payload,
  });
const sentInput = () => mock.embeddingRequests[0]!.body.input;

beforeAll(async () => {
  provider.register();
  mock = buildMockApp({ failModels: ['emb-broken'] });
  await mock.listen({ host: '127.0.0.1', port: 0 });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
});
afterAll(async () => {
  await mock.close();
  await provider.shutdown();
});
beforeEach(() => {
  mock.embeddingRequests.length = 0;
  exporter.reset();
});

describe('who may call', () => {
  it('refuses a missing or wrong key', async () => {
    build();
    const none = await gw.inject({ method: 'POST', url: '/v1/embeddings', payload: {} });
    expect(none.statusCode).toBe(401);
    const wrong = await embed(
      { model: 'auto', input: 'x' },
      { authorization: 'Bearer yanlis-anahtar' },
    );
    expect(wrong.statusCode).toBe(401);
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it('refuses unknown users, disabled users and users of another company', async () => {
    build();
    const body = { model: 'auto', input: 'x' };
    expect((await embed(body, { 'x-user-email': 'yok@acme.com.tr' })).json().error.code).toBe(
      'user_not_provisioned',
    );
    expect((await embed(body, { 'x-user-email': 'off@acme.com.tr' })).json().error.code).toBe(
      'user_disabled',
    );
    expect((await embed(body, { 'x-user-email': 'can@beta.com.tr' })).statusCode).toBe(403);
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it('refuses a suspended company, on either kind of key', async () => {
    build(acme({ status: 'suspended' }));
    expect((await embed({ model: 'auto', input: 'x' })).statusCode).toBe(403);
    expect((await asService({ model: 'auto', input: 'x' })).statusCode).toBe(403);
  });

  it("charges one company's key to that company, whatever else is sent", async () => {
    build();
    const res = await gw.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${BETA_KEY}`, 'x-user-email': 'can@beta.com.tr' },
      payload: { model: 'auto', input: 'kısa bir metin', user: 'acme:u-1', tenant: 't-acme' },
    });
    expect(res.statusCode).toBe(200);
    expect(quota.usedOf('t-beta', 'standard')).toBeGreaterThan(0);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    expect(usage.events[0]).toMatchObject({ tenantId: 't-beta', userId: 'u-9' });
    expect(mock.embeddingRequests[0]!.body).toMatchObject({ user: 'beta:u-9' });
  });
});

describe('a service key', () => {
  it('embeds with no person, and is recorded as nobody', async () => {
    build();
    const res = await asService({ model: 'emb-bge-m3', input: 'kısa bir metin' });
    expect(res.statusCode).toBe(200);
    expect(usage.events[0]).toMatchObject({ tenantId: 't-acme', userId: NO_PERSON });
    expect(quota.usedOf('t-acme', 'standard')).toBeGreaterThan(0);
  });

  it("doesn't take a person's name from a header", async () => {
    build();
    const res = await gw.inject({
      method: 'POST',
      url: '/v1/embeddings',
      headers: { authorization: `Bearer ${SERVICE_KEY}`, 'x-user-email': EMAIL },
      payload: { model: 'auto', input: 'x' },
    });
    expect(res.statusCode).toBe(200);
    expect(usage.events[0]!.userId).toBe(NO_PERSON);
  });

  it('can do nothing else', async () => {
    build();
    const headers = { authorization: `Bearer ${SERVICE_KEY}`, 'x-user-email': EMAIL };
    const chat = await gw.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: { model: 'fast', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(chat.statusCode).toBe(403);
    expect(chat.json().error.code).toBe('policy_denied');
    expect((await gw.inject({ url: '/v1/models', headers })).statusCode).toBe(403);
  });

  it('is masked by the same policy', async () => {
    build();
    await asService({ model: 'auto', input: `TCKN ${TCKN}` });
    expect(sentInput()).toBe('TCKN ⟦TR_TCKN_1⟧');
  });
});

describe('which model', () => {
  const tr: ModelEntry = {
    ...DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!,
    id: 'emb-tr',
    litellmName: 'emb-tr',
    region: 'tr',
  };
  const trOn = {
    ...DEFAULT_POLICY,
    aliases: { ...DEFAULT_POLICY.aliases, 'tr-local': true },
  };

  it('routes auto, or the id, to the embedding model', async () => {
    build();
    for (const model of ['auto', 'emb-bge-m3']) {
      const res = await embed({ model, input: 'x' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-katip-model']).toBe('emb-bge-m3');
      expect(res.json().model).toBe('emb-bge-m3');
    }
    expect(mock.embeddingRequests[0]!.body.model).toBe('emb-bge-m3');
  });

  it('allows the id without allowUserModelChoice, as nobody picks it in a chat', async () => {
    build(acme({ policy: { ...DEFAULT_POLICY, allowUserModelChoice: false } }));
    expect((await embed({ model: 'emb-bge-m3', input: 'x' })).statusCode).toBe(200);
  });

  it('refuses a chat model, and a chat alias', async () => {
    build();
    for (const model of ['std-deepseek-v4-flash', 'best', 'fast', 'bana-ozel-model']) {
      const res = await embed({ model, input: 'x' });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('policy_denied');
    }
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it("isn't stopped by allowedModels, a list of chat choices that can't name it", async () => {
    build(acme({ policy: { ...DEFAULT_POLICY, allowedModels: ['std-deepseek-v4-flash'] } }));
    expect((await embed({ model: 'auto', input: 'x' })).statusCode).toBe(200);
    expect((await asService({ model: 'emb-bge-m3', input: 'x' })).statusCode).toBe(200);
  });

  it("doesn't let allowedModels open a model the company's region forbids", async () => {
    build(
      acme({
        policy: { ...DEFAULT_POLICY, residency: 'TR_ONLY', allowedModels: ['emb-bge-m3'] },
      }),
    );
    expect((await asService({ model: 'emb-bge-m3', input: 'x' })).statusCode).toBe(403);
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it("doesn't send a Turkey-only company's text to a global model", async () => {
    build(acme({ policy: { ...DEFAULT_POLICY, residency: 'TR_ONLY' } }));
    expect((await embed({ model: 'auto', input: 'x' })).statusCode).toBe(403);
    expect((await embed({ model: 'emb-bge-m3', input: 'x' })).statusCode).toBe(403);
    expect((await asService({ model: 'emb-bge-m3', input: 'x' })).statusCode).toBe(403);
    expect(mock.embeddingRequests).toHaveLength(0);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    build(acme({ policy: { ...DEFAULT_POLICY, residency: 'TR_ONLY' } }), {
      catalog: [...DEFAULT_CATALOG, tr],
    });
    const res = await embed({ model: 'auto', input: 'x' });
    expect(res.headers['x-katip-model']).toBe('emb-tr');
  });

  it("doesn't send an EU-only company's text to a global model", async () => {
    build(acme({ policy: { ...DEFAULT_POLICY, residency: 'EU_ONLY' } }));
    expect((await asService({ model: 'emb-bge-m3', input: 'x' })).statusCode).toBe(403);
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it('says what a person can do when no model fits the company, in both languages', async () => {
    build(acme({ policy: { ...DEFAULT_POLICY, residency: 'TR_ONLY' } }));
    const error = (await asService({ model: 'emb-bge-m3', input: `TCKN ${TCKN}` })).json().error;
    expect(error.code).toBe('embedding_unavailable');
    expect(error.message).toContain('Dosya arama');
    expect(error.message).toContain('TR_ONLY');
    expect(error.message).toContain('Models and policies');
    expect(JSON.stringify(error)).not.toContain(TCKN);
  });

  it('keeps tr-local to a model in Türkiye, and to companies with it on', async () => {
    build(acme({ policy: trOn }));
    expect((await embed({ model: 'tr-local', input: 'x' })).statusCode).toBe(403);
    build(acme({ policy: trOn }), { catalog: [...DEFAULT_CATALOG, tr] });
    expect((await embed({ model: 'tr-local', input: 'x' })).headers['x-katip-model']).toBe(
      'emb-tr',
    );
    build(acme(), { catalog: [...DEFAULT_CATALOG, tr] });
    expect((await embed({ model: 'tr-local', input: 'x' })).statusCode).toBe(403);
  });

  it("never falls back to another model: its vectors wouldn't compare", async () => {
    const broken: ModelEntry = { ...tr, id: 'emb-broken', litellmName: 'emb-broken' };
    build(acme(), { catalog: [broken, ...DEFAULT_CATALOG] });
    const res = await embed({ model: 'auto', input: 'x' });
    expect(res.statusCode).toBe(502);
    expect(mock.embeddingRequests).toHaveLength(1);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    expect(usage.events).toHaveLength(0);
  });
});

describe('what leaves for the provider', () => {
  it('masks one string', async () => {
    build();
    const res = await embed({ model: 'auto', input: `Müşteri TCKN ${TCKN}` });
    expect(res.statusCode).toBe(200);
    expect(sentInput()).toBe('Müşteri TCKN ⟦TR_TCKN_1⟧');
    expect(usage.events[0]!.piiEntities).toEqual({ TR_TCKN: 1 });
  });

  it('masks each string of an array, in order', async () => {
    build();
    const res = await embed({
      model: 'auto',
      input: [`TCKN ${TCKN}`, 'içinde kişisel veri yok', `IBAN ${IBAN}`, `yine ${TCKN}`],
    });
    expect(res.statusCode).toBe(200);
    expect(sentInput()).toEqual([
      'TCKN ⟦TR_TCKN_1⟧',
      'içinde kişisel veri yok',
      'IBAN ⟦TR_IBAN_1⟧',
      'yine ⟦TR_TCKN_1⟧',
    ]);
    expect(res.json().data).toHaveLength(4);
    expect(res.json().data.map((d: { index: number }) => d.index)).toEqual([0, 1, 2, 3]);
  });

  it('masks names, in every string', async () => {
    build(acme(), { piiDetector: NAME_DETECTOR });
    await embed({ model: 'auto', input: ['Ahmet Yılmaz izinli', 'izin Ahmet Yılmaz için'] });
    expect(sentInput()).toEqual(['⟦PERSON_1⟧ izinli', 'izin ⟦PERSON_1⟧ için']);
  });

  it('numbers placeholders per request, so requests cannot be linked', async () => {
    build();
    const conversation = { 'x-conversation-id': 'sohbet-1' };
    await embed({ model: 'auto', input: `TCKN ${TCKN}` }, conversation);
    await embed({ model: 'auto', input: 'TCKN 19191919190' }, conversation);
    await embed({ model: 'auto', input: `TCKN ${TCKN}` }, conversation);
    // Two different people look the same to the provider.
    expect(mock.embeddingRequests.map((r) => r.body.input)).toEqual([
      'TCKN ⟦TR_TCKN_1⟧',
      'TCKN ⟦TR_TCKN_1⟧',
      'TCKN ⟦TR_TCKN_1⟧',
    ]);
  });

  it("leaves a placeholder that's already there, as a masked tool argument brings one", async () => {
    build(acme(), { piiDetector: NAME_DETECTOR });
    await embed({ model: 'auto', input: 'izin ⟦PERSON_3fa9c1d2⟧' });
    expect(sentInput()).toBe('izin ⟦PERSON_3fa9c1d2⟧');
  });

  it('masks for an outside model with masking off too', async () => {
    build(acme({ pii: { mode: 'off' } }), { piiDetector: NAME_DETECTOR });
    await embed({ model: 'auto', input: `Ahmet Yılmaz ${TCKN}` });
    expect(sentInput()).toBe('⟦PERSON_1⟧ ⟦TR_TCKN_1⟧');
    expect(usage.events[0]!.piiEntities).toEqual({ PERSON: 1, TR_TCKN: 1 });
  });

  it('masks a kind set to off, for an outside model', async () => {
    build(acme({ pii: { mode: 'mask', entities: { TR_TCKN: 'off' } } }));
    await embed({ model: 'auto', input: `${TCKN} ${IBAN}` });
    expect(sentInput()).toBe('⟦TR_TCKN_1⟧ ⟦TR_IBAN_1⟧');
  });

  it('never shows an outside model a real TCKN, whatever the policy', async () => {
    const down = async (): Promise<Span[]> => {
      throw new Error('analyzer down');
    };
    const policies: Tenant['pii'][] = [
      { mode: 'off' },
      { mode: 'mask' },
      { mode: 'block' },
      { mode: 'off', entities: { TR_TCKN: 'off' } },
      { mode: 'mask', entities: { TR_TCKN: 'off', PERSON: 'off' } },
      { mode: 'block', entities: { TR_TCKN: 'off' } },
      { mode: 'mask', entities: { TR_TCKN: 'block' } },
    ];
    for (const pii of policies) {
      for (const piiDetector of [undefined, NAME_DETECTOR, down]) {
        build(acme({ pii }), piiDetector ? { piiDetector } : {});
        mock.embeddingRequests.length = 0;
        await embed({ model: 'auto', input: [`TCKN ${TCKN}`, `yine ${TCKN}`] });
        await asService({ model: 'emb-bge-m3', input: `TCKN ${TCKN}` });
        expect(JSON.stringify(mock.embeddingRequests), JSON.stringify(pii)).not.toContain(TCKN);
      }
    }
  });

  it('never shows a model with no marker, or an unclear one, a real TCKN', async () => {
    const base = DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!;
    for (const selfHosted of [undefined, false, 'true', 1, null]) {
      build(acme(), { catalog: [{ ...base, selfHosted } as unknown as ModelEntry] });
      mock.embeddingRequests.length = 0;
      await embed({ model: 'auto', input: `TCKN ${TCKN}` });
      expect(sentInput(), String(selfHosted)).toBe('TCKN ⟦TR_TCKN_1⟧');
    }
  });

  it('refuses in block mode, and the provider hears nothing', async () => {
    build(acme({ pii: { mode: 'block' } }));
    const res = await embed({ model: 'auto', input: ['temiz metin', `TCKN ${TCKN}`] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pii_blocked');
    expect(mock.embeddingRequests).toHaveLength(0);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    expect(usage.events).toHaveLength(0);
    expect(res.body).not.toContain(TCKN);
  });

  it('refuses a kind set to block, among others masked', async () => {
    build(acme({ pii: { mode: 'mask', entities: { TR_IBAN: 'block' } } }));
    expect((await embed({ model: 'auto', input: `TCKN ${TCKN}` })).statusCode).toBe(200);
    expect((await embed({ model: 'auto', input: `IBAN ${IBAN}` })).statusCode).toBe(400);
  });

  it('sends only what is on the allow list', async () => {
    build();
    await embed({
      model: 'auto',
      input: 'x',
      dimensions: 256,
      encoding_format: 'float',
      extra_body: { secret: SECRET_WORD },
      metadata: { note: SECRET_WORD },
      user: SECRET_WORD,
      api_base: 'http://kotu.example',
    });
    const body = mock.embeddingRequests[0]!.body as unknown as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'dimensions',
      'encoding_format',
      'input',
      'metadata',
      'model',
      'user',
    ]);
    expect(JSON.stringify(body)).not.toContain(SECRET_WORD);
    expect(body['user']).toBe('acme:u-1');
    expect(mock.embeddingRequests[0]!.headers['authorization']).toBe('Bearer test');
  });

  it('refuses token ids, which could not be checked', async () => {
    build();
    for (const input of [[1, 2, 3], [[1, 2, 3]], ['metin', 7], 42, [], null]) {
      const res = await embed({ model: 'auto', input });
      expect(res.statusCode, JSON.stringify(input)).toBe(400);
    }
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it('keeps vectors, and base64 where asked', async () => {
    build();
    const floats = await embed({ model: 'auto', input: 'aynı metin' });
    const again = await embed({ model: 'auto', input: 'aynı metin' });
    expect(floats.json().data[0].embedding).toHaveLength(1024);
    expect(floats.json().data[0].embedding).toEqual(again.json().data[0].embedding);
    const b64 = await embed({ model: 'auto', input: 'aynı metin', encoding_format: 'base64' });
    expect(typeof b64.json().data[0].embedding).toBe('string');
  });
});

describe('a self-hosted model', () => {
  const local: ModelEntry = {
    ...DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!,
    id: 'emb-local',
    litellmName: 'emb-local',
    selfHosted: true,
  };
  const on = { catalog: [local] };
  const counting = () => {
    const calls = { n: 0 };
    return {
      calls,
      piiDetector: async (text: string) => {
        calls.n += 1;
        return NAME_DETECTOR(text);
      },
    };
  };

  it('gets the real text under mask, with nothing to count and no name check', async () => {
    const { calls, piiDetector } = counting();
    build(acme({ pii: { mode: 'mask' } }), { ...on, piiDetector });
    const text = `Ahmet Yılmaz ${TCKN} ${IBAN}`;
    const res = await asService({ model: 'emb-local', input: [text] });
    expect(res.statusCode).toBe(200);
    expect(sentInput()).toEqual([text]);
    expect(calls.n).toBe(0);
    expect(usage.events[0]).toMatchObject({ modelId: 'emb-local', piiEntities: {} });
  });

  it('gets the real text with masking off, and for a kind set to off', async () => {
    build(acme({ pii: { mode: 'off' } }), on);
    await embed({ model: 'auto', input: `TCKN ${TCKN}` });
    expect(sentInput()).toBe(`TCKN ${TCKN}`);
    mock.embeddingRequests.length = 0;
    build(acme({ pii: { mode: 'mask', entities: { TR_TCKN: 'off' } } }), on);
    await embed({ model: 'auto', input: `${TCKN} ${IBAN}` });
    expect(sentInput()).toBe(`${TCKN} ${IBAN}`);
  });

  it('is refused under block, as an outside one is: that is the rule of the company', async () => {
    for (const catalog of [[local], DEFAULT_CATALOG]) {
      build(acme({ pii: { mode: 'block' } }), { catalog });
      const res = await asService({ model: 'auto', input: ['temiz metin', `TCKN ${TCKN}`] });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('pii_blocked');
      expect(res.body).not.toContain(TCKN);
      expect(mock.embeddingRequests).toHaveLength(0);
      expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    }
  });

  it('passes clean text under block', async () => {
    build(acme({ pii: { mode: 'block' } }), on);
    expect((await embed({ model: 'auto', input: 'temiz metin' })).statusCode).toBe(200);
    expect(sentInput()).toBe('temiz metin');
  });

  it('is refused on a kind set to block, and gets the rest as it is', async () => {
    build(acme({ pii: { mode: 'mask', entities: { TR_IBAN: 'block' } } }), on);
    expect((await embed({ model: 'auto', input: `IBAN ${IBAN}` })).statusCode).toBe(400);
    expect(mock.embeddingRequests).toHaveLength(0);
    const res = await embed({ model: 'auto', input: `TCKN ${TCKN}` });
    expect(res.statusCode).toBe(200);
    expect(sentInput()).toBe(`TCKN ${TCKN}`);
    expect(JSON.stringify(mock.embeddingRequests)).not.toContain('⟦');
  });

  it('still checks names when names are blocked', async () => {
    const { calls, piiDetector } = counting();
    build(acme({ pii: { mode: 'mask', entities: { PERSON: 'block' } } }), { ...on, piiDetector });
    expect((await embed({ model: 'auto', input: 'Ahmet Yılmaz' })).statusCode).toBe(400);
    expect(calls.n).toBe(1);
    expect(mock.embeddingRequests).toHaveLength(0);
  });

  it('needs no analyzer unless names are blocked', async () => {
    const down = async (): Promise<Span[]> => {
      throw new Error('analyzer down');
    };
    build(acme({ pii: { mode: 'mask', onDetectorFailure: 'block' } }), {
      ...on,
      piiDetector: down,
    });
    const fine = await embed({ model: 'auto', input: 'Ahmet Yılmaz' });
    expect(fine.statusCode).toBe(200);
    expect(fine.headers['x-katip-pii-degraded']).toBeUndefined();
    build(acme({ pii: { mode: 'block', onDetectorFailure: 'block' } }), {
      ...on,
      piiDetector: down,
    });
    expect((await embed({ model: 'auto', input: 'Ahmet Yılmaz' })).statusCode).toBe(503);
  });

  it("doesn't change an outside model beside it", async () => {
    const outside = DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!;
    build(acme(), { catalog: [outside, local] });
    await embed({ model: 'emb-bge-m3', input: `TCKN ${TCKN}` });
    expect(sentInput()).toBe('TCKN ⟦TR_TCKN_1⟧');
  });

  it("doesn't change chat, even for a chat model marked self-hosted", async () => {
    const catalog = DEFAULT_CATALOG.map((m) => ({ ...m, selfHosted: true }));
    build(acme(), { catalog });
    const res = await gw.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${KEY}`, 'x-user-email': EMAIL },
      payload: { model: 'fast', messages: [{ role: 'user', content: `TCKN ${TCKN}` }] },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(mock.requests)).not.toContain(TCKN);
  });

  it('keeps real text out of traces and metrics', async () => {
    build(acme(), on);
    await embed({ model: 'auto', input: `${SECRET_WORD} ${TCKN}` });
    const traces = JSON.stringify(
      exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.status, s.events]),
    );
    const out = await metrics.registry.metrics();
    for (const secret of [SECRET_WORD, TCKN]) {
      expect(traces).not.toContain(secret);
      expect(out).not.toContain(secret);
    }
    const pii = exporter.getFinishedSpans().find((s) => s.name === 'pii')!;
    expect(pii.attributes).toMatchObject({ 'pii.self_hosted': true, 'pii.entities_count': 0 });
  });
});

describe('when names cannot be checked', () => {
  const down = async (): Promise<Span[]> => {
    throw new Error('analyzer down');
  };

  it('sends with structured masking under allow, and says so', async () => {
    build(acme(), { piiDetector: down });
    const res = await embed({ model: 'auto', input: ['Ahmet Yılmaz', `TCKN ${TCKN}`] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-katip-pii-degraded']).toBe('true');
    expect(sentInput()).toEqual(['Ahmet Yılmaz', 'TCKN ⟦TR_TCKN_1⟧']);
    expect(await metrics.registry.metrics()).toContain(
      'gw_pii_detector_failures_total{tenant="acme",action="allowed"} 1',
    );
  });

  it('refuses under block, and the provider hears nothing', async () => {
    build(acme({ pii: { mode: 'mask', onDetectorFailure: 'block' } }), { piiDetector: down });
    const res = await embed({ model: 'auto', input: 'Ahmet Yılmaz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('pii_unavailable');
    expect(mock.embeddingRequests).toHaveLength(0);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    expect(await metrics.registry.metrics()).toContain(
      'gw_pii_detector_failures_total{tenant="acme",action="blocked"} 1',
    );
  });

  it("isn't asked again in that request, so an outage costs one timeout", async () => {
    let calls = 0;
    build(acme(), {
      piiDetector: async () => {
        calls += 1;
        throw new Error('analyzer down');
      },
    });
    await embed({ model: 'auto', input: ['bir', 'iki', 'üç'] });
    expect(calls).toBe(1);
  });
});

describe('metering', () => {
  it('records the usage as embedding, at standard quota', async () => {
    build();
    const res = await embed({ model: 'auto', input: ['bir metin', 'iki metin'] });
    expect(res.statusCode).toBe(200);
    const event = usage.events[0]!;
    expect(event).toMatchObject({
      tenantId: 't-acme',
      userId: 'u-1',
      source: 'embedding',
      alias: 'auto',
      modelId: 'emb-bge-m3',
      modelClass: 'embedding',
      outputTokens: 0,
      fallback: false,
      overage: false,
    });
    expect(event.inputTokens).toBeGreaterThan(0);
    expect(res.json().usage.prompt_tokens).toBe(event.inputTokens);
    // Settled to what the provider reported, not the estimate.
    expect(quota.usedOf('t-acme', 'standard')).toBe(event.inputTokens);
    expect(quota.usedOf('t-acme', 'premium')).toBe(0);
  });

  it('prices it at the model', async () => {
    build(acme({ limits: { standard: 10_000_000, premium: 0 } }));
    await embed({ model: 'auto', input: 'x'.repeat(4_000_000) });
    // 1M tokens from the mock, at 10,000 micro-USD per 1M.
    expect(usage.events[0]!.inputTokens).toBe(1_000_000);
    expect(usage.events[0]!.costMicroUsd).toBe(10_000);
  });

  it('counts the estimate if the provider reports no usage', async () => {
    build(acme(), {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }),
    });
    const res = await embed({ model: 'auto', input: 'x'.repeat(35) });
    expect(res.statusCode).toBe(200);
    expect(usage.events[0]!.inputTokens).toBe(10);
    expect(quota.usedOf('t-acme', 'standard')).toBe(10);
  });

  it('refuses a provider that returns the wrong number of vectors, and charges nothing', async () => {
    build(acme(), {
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [{ embedding: [1] }] }), { status: 200 }),
    });
    const res = await embed({ model: 'auto', input: ['bir', 'iki'] });
    expect(res.statusCode).toBe(502);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
    expect(usage.events).toHaveLength(0);
  });

  it('refuses what is over quota under block', async () => {
    build(
      acme({
        limits: { standard: 1, premium: 1 },
        policy: { ...DEFAULT_POLICY, atQuotaLimit: 'block' },
      }),
    );
    const res = await embed({ model: 'auto', input: 'uzun bir metin burada duruyor' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('quota_exceeded');
    expect(mock.embeddingRequests).toHaveLength(0);
    expect(await metrics.registry.metrics()).toContain(
      'gw_quota_denials_total{tenant="acme",class="standard"} 1',
    );
  });

  it('refuses it under downgrade too, having nothing cheaper to go to', async () => {
    build(acme({ limits: { standard: 1, premium: 1_000_000 } }));
    const res = await embed({ model: 'auto', input: 'uzun bir metin burada duruyor' });
    expect(res.statusCode).toBe(429);
    expect(mock.embeddingRequests).toHaveLength(0);
    expect(quota.usedOf('t-acme', 'premium')).toBe(0);
  });

  it('continues and flags it under overage', async () => {
    build(
      acme({
        limits: { standard: 1, premium: 1 },
        policy: { ...DEFAULT_POLICY, atQuotaLimit: 'overage' },
      }),
    );
    const res = await embed({ model: 'auto', input: 'uzun bir metin burada duruyor' });
    expect(res.statusCode).toBe(200);
    expect(usage.events[0]!.overage).toBe(true);
  });

  it('gives back the hold when the provider rejects', async () => {
    build(acme(), {
      fetchImpl: async () => new Response('{"error":"hayır"}', { status: 400 }),
    });
    expect((await embed({ model: 'auto', input: 'metin' })).statusCode).toBe(400);
    expect(quota.usedOf('t-acme', 'standard')).toBe(0);
  });
});

describe('metrics and traces', () => {
  it('counts a request, its tokens and what was masked, by company', async () => {
    build();
    await embed({ model: 'auto', input: `TCKN ${TCKN}` });
    const out = await metrics.registry.metrics();
    expect(out).toContain(
      'gw_requests_total{tenant="acme",alias="auto",model="emb-bge-m3",status="200"} 1',
    );
    expect(out).toMatch(/gw_tokens_total\{tenant="acme",class="embedding",dir="input"\} [1-9]/);
    expect(out).toContain('gw_pii_entities_total{type="TR_TCKN"} 1');
    expect(out).toContain('gw_upstream_latency_seconds_count{tenant="acme",model="emb-bge-m3"} 1');
    expect(out).toContain('gw_overhead_seconds_count{tenant="acme"} 1');
  });

  it("doesn't put a model name a caller made up in a label", async () => {
    build();
    await embed({ model: 'bana-ozel-model', input: 'x' });
    const out = await metrics.registry.metrics();
    expect(out).not.toContain('bana-ozel-model');
    expect(out).toContain('alias="explicit"');
  });

  it('has a span for each stage, inside one trace', async () => {
    build();
    await embed({ model: 'auto', input: `TCKN ${TCKN}` });
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    for (const stage of ['auth', 'policy', 'pii', 'route', 'upstream', 'settle']) {
      expect(names).toContain(stage);
    }
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const root = spans.find((s) => s.name === 'gateway.embeddings')!;
    expect(root.attributes).toMatchObject({
      'tenant.slug': 'acme',
      'model.alias': 'auto',
      'model.name': 'emb-bge-m3',
      'quota.class': 'standard',
    });
    expect(spans.find((s) => s.name === 'pii')!.attributes['pii.entities_count']).toBe(1);
  });

  it('never holds text, a value or a person, on success or failure', async () => {
    const text = `${SECRET_WORD} ${TCKN} Ahmet Yılmaz`;
    build(acme(), { piiDetector: NAME_DETECTOR });
    await embed({ model: 'auto', input: [text] });
    await embed({ model: 'yok', input: text });
    build(acme({ pii: { mode: 'block' } }), { piiDetector: NAME_DETECTOR });
    expect((await embed({ model: 'auto', input: text })).statusCode).toBe(400);
    const traces = JSON.stringify(
      exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.status, s.events]),
    );
    const out = await metrics.registry.metrics();
    for (const secret of [SECRET_WORD, TCKN, 'Ahmet', EMAIL, 'u-1', KEY]) {
      expect(traces).not.toContain(secret);
      expect(out).not.toContain(secret);
    }
  });

  it('marks a refused request with its code', async () => {
    build(acme({ pii: { mode: 'block' } }));
    await embed({ model: 'auto', input: `TCKN ${TCKN}` });
    const root = exporter.getFinishedSpans().find((s) => s.name === 'gateway.embeddings')!;
    expect(root.status.code).toBe(2);
    expect(root.status.message).toBe('pii_blocked');
  });
});
