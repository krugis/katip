// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockApp } from '@katip/mock-llm';
import { DEFAULT_POLICY } from '@katip/policy-engine';
import { createLogger } from '@katip/shared';
import { buildGateway } from '../src/app.js';
import {
  MemoryQuotaStore,
  MemoryTenantStore,
  MemoryUsageSink,
  type Tenant,
} from '../src/stores.js';

const KEY_A = 'sk-katip-acme-test';
const KEY_B = 'sk-katip-beta-test';

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    id: 't-acme',
    slug: 'acme',
    status: 'active',
    policy: { ...DEFAULT_POLICY },
    pii: { mode: 'mask' },
    kvkkAddon: false,
    limits: { standard: 1_000_000, premium: 100_000 },
    ...over,
  };
}

let mock: ReturnType<typeof buildMockApp>;
let mockUrl: string;
let gw: FastifyInstance;
let usage: MemoryUsageSink;
let quota: MemoryQuotaStore;
let tenants: MemoryTenantStore;

beforeAll(async () => {
  mock = buildMockApp({ failModels: ['std-deepseek-v4-flash-broken'], chunkSize: 4 });
  await mock.listen({ host: '127.0.0.1', port: 0 });
  const addr = mock.server.address();
  mockUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
});
afterAll(async () => {
  await mock.close();
});

function build(t: Tenant = tenant(), extra: Partial<Parameters<typeof buildGateway>[0]> = {}) {
  tenants = new MemoryTenantStore();
  tenants.addTenant(t, [KEY_A]);
  tenants.addUser({ id: 'u-1', tenantId: t.id, email: 'ayse@acme.com.tr', status: 'active' });
  tenants.addUser({ id: 'u-2', tenantId: t.id, email: 'off@acme.com.tr', status: 'disabled' });
  const other = tenant({ id: 't-beta', slug: 'beta' });
  tenants.addTenant(other, [KEY_B]);
  tenants.addUser({ id: 'u-9', tenantId: other.id, email: 'can@beta.com.tr', status: 'active' });
  usage = new MemoryUsageSink();
  quota = new MemoryQuotaStore();
  gw = buildGateway({
    litellmBaseUrl: mockUrl,
    litellmApiKey: 'test',
    tenants,
    quota,
    usage,
    logger: createLogger('test', { level: 'silent' }),
    ...extra,
  });
  return gw;
}

const chat = (payload: object, headers: Record<string, string> = {}) =>
  gw.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY_A}`, 'x-user-email': 'ayse@acme.com.tr', ...headers },
    payload,
  });

beforeEach(() => {
  mock.requests.length = 0;
});

describe('authentication and identity', () => {
  it('rejects a missing or wrong key with 401 (OpenAI error shape)', async () => {
    build();
    const res = await gw.inject({ method: 'POST', url: '/v1/chat/completions', payload: {} });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    const wrong = await chat(
      { model: 'auto', messages: [{ role: 'user', content: 'x' }] },
      { authorization: 'Bearer nope' },
    );
    expect(wrong.statusCode).toBe(401);
  });

  it('rejects unknown users, disabled users and users of another tenant', async () => {
    build();
    const msg = { model: 'auto', messages: [{ role: 'user', content: 'x' }] };
    expect((await chat(msg, { 'x-user-email': 'nobody@acme.com.tr' })).json().error.code).toBe(
      'user_not_provisioned',
    );
    expect((await chat(msg, { 'x-user-email': 'off@acme.com.tr' })).json().error.code).toBe(
      'user_disabled',
    );
    // user exists, but in tenant beta – must not be usable with tenant acme's key
    expect((await chat(msg, { 'x-user-email': 'can@beta.com.tr' })).statusCode).toBe(403);
  });

  it('rejects a suspended tenant', async () => {
    build(tenant({ status: 'suspended' }));
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('policy_denied');
  });
});

describe('models', () => {
  it('lists only enabled aliases; tr-local needs the KVKK add-on', async () => {
    build(
      tenant({
        policy: { ...DEFAULT_POLICY, aliases: { ...DEFAULT_POLICY.aliases, 'tr-local': true } },
      }),
    );
    const res = await gw.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { authorization: `Bearer ${KEY_A}`, 'x-user-email': 'ayse@acme.com.tr' },
    });
    expect(res.json().data.map((m: { id: string }) => m.id)).toEqual(['auto', 'fast', 'best']);
  });
});

describe('chat pipeline', () => {
  it('routes auto to DeepSeek V4 Flash, masks PII upstream and restores it for the user', async () => {
    build();
    const res = await chat({
      model: 'auto',
      messages: [
        {
          role: 'user',
          content: 'Müşteri TCKN 10000000146, IBAN TR33 0006 1005 1978 6457 8413 26',
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-katip-model']).toBe('std-deepseek-v4-flash');
    const upstream = mock.requests[0]!.body;
    expect(upstream.model).toBe('std-deepseek-v4-flash');
    expect(JSON.stringify(upstream.messages)).not.toContain('10000000146');
    expect(JSON.stringify(upstream.messages)).toContain('⟦TR_TCKN_1⟧');
    expect(res.json().choices[0].message.content).toBe(
      'Echo: Müşteri TCKN 10000000146, IBAN TR33 0006 1005 1978 6457 8413 26',
    );
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({
      tenantId: 't-acme',
      userId: 'u-1',
      modelId: 'std-deepseek-v4-flash',
      piiEntities: { TR_TCKN: 1, TR_IBAN: 1 },
    });
    expect(usage.events[0]!.costMicroUsd).toBeGreaterThan(0);
  });

  it('streams, restoring placeholders split across chunks', async () => {
    build();
    const res = await chat({
      model: 'auto',
      stream: true,
      messages: [{ role: 'user', content: 'Telefon 0532 123 45 67 kayıtlı' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const events = res.body.split('\n\n').filter(Boolean);
    expect(events.at(-1)).toBe('data: [DONE]');
    const text = events
      .filter((e) => e !== 'data: [DONE]')
      .map((e) => JSON.parse(e.slice(6)))
      .map((c) => c.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Echo: Telefon 0532 123 45 67 kayıtlı');
    expect(text).not.toContain('⟦');
    expect(usage.events[0]!.outputTokens).toBeGreaterThan(0);
  });

  it('blocks a request when an entity is in block mode', async () => {
    build(tenant({ pii: { mode: 'mask', entities: { TR_TCKN: 'block' } } }));
    const res = await chat({
      model: 'auto',
      messages: [{ role: 'user', content: 'TCKN 10000000146' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('pii_blocked');
    expect(mock.requests).toHaveLength(0);
  });

  it('falls back to the next model when the primary fails', async () => {
    const t = tenant();
    build(t, {
      catalog: undefined,
      rules: [
        {
          id: 'auto-default',
          priority: 50,
          when: { alias: ['auto'] },
          models: ['broken', 'std-glm-5.3-flash'],
        },
      ],
    });
    // inject a broken catalog entry whose litellm name the mock fails
    gw = buildGateway({
      litellmBaseUrl: mockUrl,
      litellmApiKey: 'test',
      tenants,
      quota,
      usage,
      logger: createLogger('test', { level: 'silent' }),
      rules: [
        {
          id: 'auto-default',
          priority: 50,
          when: { alias: ['auto'] },
          models: ['broken', 'std-glm-5.3-flash'],
        },
      ],
      catalog: [
        {
          id: 'broken',
          litellmName: 'std-deepseek-v4-flash-broken',
          displayName: 'Broken',
          class: 'standard',
          region: 'global',
          dataPolicy: 'zero_retention',
          priceInMicroPerM: 1,
          priceOutMicroPerM: 1,
          enabled: true,
        },
        {
          id: 'std-glm-5.3-flash',
          litellmName: 'std-glm-5.3-flash',
          displayName: 'GLM',
          class: 'standard',
          region: 'global',
          dataPolicy: 'zero_retention',
          priceInMicroPerM: 1,
          priceOutMicroPerM: 1,
          enabled: true,
        },
      ],
    });
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Merhaba' }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-katip-fallback']).toBe('true');
    expect(res.headers['x-katip-model']).toBe('std-glm-5.3-flash');
    expect(usage.events.at(-1)!.fallback).toBe(true);
  });

  it('denies explicit model ids unless the tenant allows model choice', async () => {
    build();
    const res = await chat({
      model: 'prem-claude-sonnet-5.5',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.statusCode).toBe(403);
    build(tenant({ policy: { ...DEFAULT_POLICY, allowUserModelChoice: true } }));
    const ok = await chat({
      model: 'prem-claude-sonnet-5.5',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('quota behaviour at the limit', () => {
  it('block → 429 with an OpenAI rate-limit error', async () => {
    build(
      tenant({
        limits: { standard: 10, premium: 0 },
        policy: { ...DEFAULT_POLICY, atQuotaLimit: 'block' },
      }),
    );
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Merhaba' }] });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.type).toBe('rate_limit_error');
  });

  it('downgrade → best is served by a standard model when premium is exhausted', async () => {
    build(
      tenant({
        limits: { standard: 1_000_000, premium: 0 },
        policy: { ...DEFAULT_POLICY, atQuotaLimit: 'downgrade' },
      }),
    );
    const res = await chat({ model: 'best', messages: [{ role: 'user', content: 'Merhaba' }] });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-katip-model']).toBe('std-deepseek-v4-flash');
  });

  it('overage → allowed and flagged', async () => {
    build(
      tenant({
        limits: { standard: 10, premium: 0 },
        policy: { ...DEFAULT_POLICY, atQuotaLimit: 'overage' },
      }),
    );
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: 'Merhaba' }] });
    expect(res.statusCode).toBe(200);
    expect(usage.events[0]!.overage).toBe(true);
  });

  it('settles the reservation to the actual token count', async () => {
    build();
    await chat({ model: 'auto', messages: [{ role: 'user', content: 'Merhaba' }] });
    const e = usage.events[0]!;
    expect(quota.usedOf('t-acme', 'standard')).toBe(e.inputTokens + e.outputTokens);
  });
});
