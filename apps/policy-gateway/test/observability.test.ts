// SPDX-License-Identifier: AGPL-3.0-only
import { buildMockApp } from '@katip/mock-llm';
import { DEFAULT_POLICY } from '@katip/policy-engine';
import { createLogger } from '@katip/shared';
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@katip/shared/tracing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/app.js';
import { GatewayMetrics, buildMetricsServer } from '../src/metrics.js';
import {
  MemoryQuotaStore,
  MemoryTenantStore,
  MemoryUsageSink,
  type Tenant,
} from '../src/stores.js';

const KEY = 'sk-katip-acme-test';
const EMAIL = 'ayse@acme.com.tr';
const SECRET_WORD = 'GizliKelime73';
const TCKN = '10000000146';

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

let mock: ReturnType<typeof buildMockApp>;
let mockUrl: string;
let gw: FastifyInstance;
let metrics: GatewayMetrics;
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = provider.getTracer('test');

function build(t: Tenant = acme(), extra: Partial<Parameters<typeof buildGateway>[0]> = {}) {
  const tenants = new MemoryTenantStore();
  tenants.addTenant(t, [KEY]);
  tenants.addUser({ id: 'u-1', tenantId: t.id, email: EMAIL, status: 'active' });
  metrics = new GatewayMetrics();
  gw = buildGateway({
    litellmBaseUrl: mockUrl,
    litellmApiKey: 'test',
    tenants,
    quota: new MemoryQuotaStore(),
    usage: new MemoryUsageSink(),
    logger: createLogger('test', { level: 'silent' }),
    metrics,
    tracer,
    ...extra,
  });
}

const chat = (payload: object, key = KEY) =>
  gw.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${key}`, 'x-user-email': EMAIL },
    payload,
  });
const say = (extra: object = {}) => ({
  model: 'fast',
  messages: [{ role: 'user', content: `${SECRET_WORD} ${TCKN}` }],
  ...extra,
});
const text = () => metrics.registry.metrics();

beforeAll(async () => {
  provider.register();
  mock = buildMockApp({ chunkSize: 4 });
  await mock.listen({ host: '127.0.0.1', port: 0 });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
});
afterAll(async () => {
  await mock.close();
  await provider.shutdown();
});
beforeEach(() => exporter.reset());

describe('metrics', () => {
  it('counts a request, its tokens and what was masked, by company', async () => {
    build();
    expect((await chat(say())).statusCode).toBe(200);
    const out = await text();
    expect(out).toMatch(
      /gw_requests_total\{tenant="acme",alias="fast",model="[^"]+",status="200"\} 1/,
    );
    expect(out).toMatch(/gw_tokens_total\{tenant="acme",class="[a-z]+",dir="input"\} [1-9]/);
    expect(out).toMatch(/gw_tokens_total\{tenant="acme",class="[a-z]+",dir="output"\} [1-9]/);
    expect(out).toContain('gw_pii_entities_total{type="TR_TCKN"} 1');
    expect(out).toMatch(/gw_upstream_latency_seconds_count\{tenant="acme",model="[^"]+"\} 1/);
    expect(out).toContain('gw_overhead_seconds_count{tenant="acme"} 1');
  });

  it('counts a streamed request, once', async () => {
    build();
    expect((await chat(say({ stream: true }))).statusCode).toBe(200);
    const out = await text();
    expect(out).toMatch(
      /gw_requests_total\{tenant="acme",alias="fast",model="[^"]+",status="200"\} 1/,
    );
    expect(out).toMatch(/gw_tokens_total\{tenant="acme",class="[a-z]+",dir="output"\} [1-9]/);
  });

  it('refuses a wrong key without naming a company, or anything the caller sent', async () => {
    build();
    expect((await chat(say(), 'sk-made-up-company')).statusCode).toBe(401);
    const out = await text();
    expect(out).toContain(
      'gw_requests_total{tenant="unknown",alias="unknown",model="unknown",status="401"} 1',
    );
    expect(out).not.toContain('sk-made-up');
  });

  it("doesn't put a model name a caller made up in a label", async () => {
    build();
    await chat(say({ model: 'bana-ozel-model' }));
    const out = await text();
    expect(out).not.toContain('bana-ozel-model');
    expect(out).toContain('alias="explicit"');
  });

  it('counts being over quota', async () => {
    build(acme({ limits: { standard: 1, premium: 1 } }));
    expect((await chat(say({ max_tokens: 100_000 }))).statusCode).toBe(429);
    expect(await text()).toMatch(/gw_quota_denials_total\{tenant="acme",class="[a-z]+"\} 1/);
  });

  it('counts name checks that failed', async () => {
    build(acme(), {
      piiDetector: async () => {
        throw new Error('analyzer down');
      },
    });
    await chat(say());
    expect(await text()).toContain(
      'gw_pii_detector_failures_total{tenant="acme",action="allowed"} 1',
    );
  });

  it('never holds a prompt, a value, or a person', async () => {
    build();
    await chat(say());
    await chat(say({ stream: true }));
    const out = await text();
    for (const secret of [SECRET_WORD, TCKN, EMAIL, 'u-1']) expect(out).not.toContain(secret);
  });

  it('is not served on the public port', async () => {
    build();
    expect((await gw.inject({ url: '/metrics' })).statusCode).toBe(404);
  });
});

describe('the metrics port', () => {
  it('asks for its token', async () => {
    const own = new GatewayMetrics();
    const server = buildMetricsServer(own, 't'.repeat(40));
    const get = (authorization?: string) =>
      server.inject({ url: '/metrics', headers: authorization ? { authorization } : {} });
    expect((await get()).statusCode).toBe(401);
    expect((await get('Bearer wrong')).statusCode).toBe(401);
    const ok = await get(`Bearer ${'t'.repeat(40)}`);
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('gw_requests_total');
    await server.close();
  });
});

describe('traces', () => {
  const names = () => exporter.getFinishedSpans().map((s) => s.name);

  it('has a span for each stage, inside one trace', async () => {
    build();
    await chat(say());
    const spans = exporter.getFinishedSpans();
    for (const stage of ['auth', 'policy', 'pii', 'route', 'upstream', 'settle']) {
      expect(names()).toContain(stage);
    }
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it('says which company and model, and how much was masked', async () => {
    build();
    await chat(say());
    const root = exporter.getFinishedSpans().find((s) => s.name === 'gateway.chat')!;
    expect(root.attributes).toMatchObject({ 'tenant.slug': 'acme', 'model.alias': 'fast' });
    expect(root.attributes['model.name']).toBeTruthy();
    expect(root.attributes['quota.class']).toBeTruthy();
    const pii = exporter.getFinishedSpans().find((s) => s.name === 'pii')!;
    expect(pii.attributes['pii.entities_count']).toBe(1);
  });

  it('never holds a prompt, a value, or a person, on success or failure', async () => {
    build();
    await chat(say());
    await chat(say({ stream: true }));
    build(acme({ pii: { mode: 'block' } }));
    expect((await chat(say())).statusCode).toBeGreaterThanOrEqual(400);
    const all = JSON.stringify(
      exporter.getFinishedSpans().map((s) => [s.name, s.attributes, s.status, s.events]),
    );
    for (const secret of [SECRET_WORD, TCKN, EMAIL, 'u-1', KEY]) {
      expect(all).not.toContain(secret);
    }
  });

  it('marks a refused request with its code', async () => {
    build(acme({ pii: { mode: 'block' } }));
    await chat(say());
    const pii = exporter.getFinishedSpans().find((s) => s.name === 'gateway.chat')!;
    expect(pii.status.code).toBe(2);
    expect(pii.status.message).toBe('pii_blocked');
  });
});
