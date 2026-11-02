// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildMockApp } from '@katip/mock-llm';
import { DEFAULT_POLICY } from '@katip/policy-engine';
import type { Span } from '@katip/pii';
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

describe('readiness', () => {
  it('reports ready by default, and healthz does not depend on it', async () => {
    build();
    expect((await gw.inject({ url: '/readyz' })).statusCode).toBe(200);
    build(tenant(), { ready: async () => false });
    expect((await gw.inject({ url: '/healthz' })).statusCode).toBe(200);
    const res = await gw.inject({ url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('not_ready');
  });

  it('is not ready while the check throws (e.g. DB not migrated)', async () => {
    build(tenant(), {
      ready: async () => {
        throw new Error('relation "model_catalog" does not exist');
      },
    });
    expect((await gw.inject({ url: '/readyz' })).statusCode).toBe(503);
  });
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

  it('masks PERSON names via the extra NER detector', async () => {
    const detector = async (text: string): Promise<Span[]> => [
      { type: 'PERSON', start: 0, end: 12, value: text.slice(0, 12), score: 0.85 },
    ];
    build(tenant(), { piiDetector: detector });
    const res = await chat({
      model: 'auto',
      messages: [{ role: 'user', content: "Ahmet Yilmaz yarin Ankara'ya gidiyor" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-katip-pii-degraded']).toBeUndefined();
    const sent = mock.requests[0]!.body;
    expect(sent.messages[0]!.content).toMatch(/^⟦PERSON_1⟧ yarin/);
    expect(sent.messages[0]!.content).not.toContain('Ahmet');
  });

  describe('when the PII detector fails', () => {
    const down = async (): Promise<Span[]> => {
      throw new Error('analyzer down');
    };
    /** Logger that records what the gateway logs at error level. */
    const capturingLogger = () => {
      const logged: unknown[] = [];
      const logger = createLogger('test', {
        level: 'error',
        hooks: {
          logMethod(args, method) {
            logged.push(args[0]);
            method.apply(this, args);
          },
        },
      });
      return { logged, logger };
    };
    const content = 'Ayse Kaya burada mi, TCKN 10000000146';

    it('allows by default: structured masking still applies, flagged and logged', async () => {
      const { logged, logger } = capturingLogger();
      build(tenant(), { piiDetector: down, logger });
      const res = await chat({ model: 'auto', messages: [{ role: 'user', content }] });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-katip-pii-degraded']).toBe('true');
      const sent = mock.requests[0]!.body.messages[0]!.content;
      expect(sent).toContain('⟦TR_TCKN_1⟧');
      expect(logged).toContainEqual({
        event: 'pii_detector_failed',
        tenant_id: 't-acme',
        user_id: 'u-1',
        action: 'allowed',
      });
      expect(JSON.stringify(logged)).not.toContain('Ayse');
    });

    it('rejects with 503 when the tenant chose block: provider is not called', async () => {
      const { logged, logger } = capturingLogger();
      build(tenant({ pii: { mode: 'mask', onDetectorFailure: 'block' } }), {
        piiDetector: down,
        logger,
      });
      const res = await chat({ model: 'auto', messages: [{ role: 'user', content }] });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('pii_unavailable');
      expect(mock.requests).toHaveLength(0);
      expect(usage.events).toHaveLength(0);
      expect(logged).toContainEqual({
        event: 'pii_detector_failed',
        tenant_id: 't-acme',
        user_id: 'u-1',
        action: 'blocked',
      });
    });

    it('does not block a tenant with PERSON masking off, since no names are checked', async () => {
      build(
        tenant({ pii: { mode: 'mask', entities: { PERSON: 'off' }, onDetectorFailure: 'block' } }),
        {
          piiDetector: down,
        },
      );
      const res = await chat({ model: 'auto', messages: [{ role: 'user', content }] });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-katip-pii-degraded']).toBeUndefined();
    });
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

describe('what leaves for the provider', () => {
  const TCKN = '10000000146';
  const secret = `Ahmet Yilmaz TCKN ${TCKN}`;
  const detector = async (text: string): Promise<Span[]> => {
    const i = text.indexOf('Ahmet Yilmaz');
    return i < 0
      ? []
      : [{ type: 'PERSON', start: i, end: i + 12, value: 'Ahmet Yilmaz', score: 0.9 }];
  };
  const sent = () => JSON.stringify(mock.requests.at(-1)?.body);
  const user = { role: 'user', content: 'merhaba' };

  it.each<[string, object]>([
    [
      'earlier tool-call arguments',
      {
        messages: [
          user,
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: '1',
                type: 'function',
                function: { name: 'ara', arguments: JSON.stringify({ q: secret }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: '1', content: 'ok' },
        ],
      },
    ],
    [
      'tool definitions',
      {
        messages: [user],
        tools: [
          {
            type: 'function',
            function: { name: 'ara', description: secret, parameters: { type: 'object' } },
          },
        ],
      },
    ],
    ['message name', { messages: [{ role: 'user', name: secret, content: 'x' }] }],
    ['metadata and unknown fields', { messages: [user], metadata: { n: secret }, custom: secret }],
    [
      'response schema',
      {
        messages: [user],
        response_format: { type: 'json_schema', json_schema: { schema: { description: secret } } },
      },
    ],
    [
      'file name',
      { messages: [{ role: 'user', content: [{ type: 'file', file: { filename: secret } }] }] },
    ],
    ['tool results', { messages: [user, { role: 'tool', tool_call_id: '1', content: secret }] }],
  ])('masks or drops: %s', async (_label, payload) => {
    build(tenant(), { piiDetector: detector });
    const res = await chat({ model: 'auto', ...payload });
    expect(res.statusCode).toBe(200);
    expect(sent()).not.toContain(TCKN);
    expect(sent()).not.toContain('Ahmet');
  });

  it('allows images and files through for now, and logs that it did', async () => {
    const logged: unknown[] = [];
    const logger = createLogger('test', {
      level: 'info',
      hooks: {
        logMethod(args, method) {
          logged.push(args[0]);
          method.apply(this, args);
        },
      },
    });
    build(tenant(), { piiDetector: detector, logger });
    const image = { type: 'image_url', image_url: { url: 'https://x.test/a.png' } };
    const res = await chat({ model: 'auto', messages: [{ role: 'user', content: [image] }] });
    expect(res.statusCode).toBe(200);
    expect(sent()).toContain('https://x.test/a.png');
    expect(logged).toContainEqual({
      event: 'non_text_content_sent',
      tenant_id: 't-acme',
      user_id: 'u-1',
      parts: { image_url: 1 },
    });
  });

  it('logs dropped field names, never their values', async () => {
    const logged: unknown[] = [];
    const logger = createLogger('test', {
      level: 'warn',
      hooks: {
        logMethod(args, method) {
          logged.push(args[0]);
          method.apply(this, args);
        },
      },
    });
    build(tenant(), { logger });
    await chat({ model: 'auto', messages: [user], custom: secret });
    expect(logged).toContainEqual({
      event: 'request_fields_dropped',
      tenant_id: 't-acme',
      fields: ['custom'],
    });
    expect(JSON.stringify(logged)).not.toContain(TCKN);
  });
});

describe('placeholders across a conversation', () => {
  const KEY = 'k'.repeat(32);
  const a = 'Ahmet Yilmaz';
  const b = 'Mehmet Kaya';
  const detector = async (text: string): Promise<Span[]> =>
    [a, b].flatMap((name) => {
      const i = text.indexOf(name);
      return i < 0
        ? []
        : [{ type: 'PERSON' as const, start: i, end: i + name.length, value: name, score: 0.9 }];
    });
  const sentText = () => JSON.stringify(mock.requests.at(-1)?.body.messages);
  const send = (content: string, conversation?: string) =>
    chat(
      { model: 'auto', messages: [{ role: 'user', content }] },
      conversation ? { 'x-conversation-id': conversation } : {},
    );
  const tokenOf = (text: string) => text.match(/⟦PERSON_[0-9a-f]+⟧/)?.[0];

  it("keeps a person's placeholder between requests, whoever else is mentioned", async () => {
    build(tenant(), { piiDetector: detector, piiTokenKey: KEY });
    await send(a, 'c-1');
    const first = tokenOf(sentText());
    await send(`${b} ve ${a}`, 'c-1');
    expect(first).toBeDefined();
    expect(sentText()).toContain(first!);
  });

  it('uses other placeholders in another conversation', async () => {
    build(tenant(), { piiDetector: detector, piiTokenKey: KEY });
    await send(a, 'c-1');
    const first = tokenOf(sentText());
    await send(a, 'c-2');
    expect(sentText()).not.toContain(first!);
  });

  it('matches a placeholder from earlier tool arguments, so the reply can be restored', async () => {
    build(tenant(), { piiDetector: detector, piiTokenKey: KEY });
    await send(a, 'c-1');
    const token = tokenOf(sentText())!;
    const res = await chat(
      {
        model: 'auto',
        messages: [
          { role: 'user', content: `${a} kim?` },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: '1',
                type: 'function',
                function: { name: 'ara', arguments: JSON.stringify({ q: token }) },
              },
            ],
          },
          { role: 'tool', tool_call_id: '1', content: `Sonuç: ${token}` },
        ],
      },
      { 'x-conversation-id': 'c-1' },
    );
    expect(res.statusCode).toBe(200);
    // The mock echoes the last message: the tool result, holding the same placeholder.
    expect(res.json().choices[0].message.content).toContain(a);
    const toolCalls = sentText();
    expect(toolCalls).not.toContain(a);
    expect(toolCalls.match(/PERSON_[0-9a-f]+/g)?.every((p) => token.includes(p))).toBe(true);
  });

  it('numbers placeholders per request without a key or conversation id', async () => {
    build(tenant(), { piiDetector: detector });
    await send(a, 'c-1');
    expect(sentText()).toContain('⟦PERSON_1⟧');
    build(tenant(), { piiDetector: detector, piiTokenKey: KEY });
    await send(a);
    expect(sentText()).toContain('⟦PERSON_1⟧');
    await send(a, '{{LIBRECHAT_BODY_CONVERSATIONID}}');
    expect(sentText()).toContain('⟦PERSON_1⟧');
  });
});

describe('which tools a model asked to call', () => {
  const user = { role: 'user', content: 'ara lütfen [[use-tool]]' };
  const tools = [
    { type: 'function', function: { name: 'hava_durumu', parameters: { type: 'object' } } },
  ];

  it.each([
    ['non-streaming', false],
    ['streaming', true],
  ])('records and logs the name, never the arguments: %s', async (_label, stream) => {
    const logged: unknown[] = [];
    const logger = createLogger('test', {
      level: 'info',
      hooks: {
        logMethod(args, method) {
          logged.push(args[0]);
          method.apply(this, args);
        },
      },
    });
    build(tenant(), { logger });
    const res = await chat(
      {
        model: 'auto',
        stream,
        messages: [{ ...user, content: `${user.content} 10000000146` }],
        tools,
      },
      { 'x-conversation-id': 'c-9' },
    );
    expect(res.statusCode).toBe(200);
    expect(usage.events.at(-1)?.toolCalls).toEqual(['hava_durumu']);
    const event = logged.find((l) => (l as { event?: string }).event === 'tool_calls_requested');
    expect(event).toEqual({
      event: 'tool_calls_requested',
      tenant_id: 't-acme',
      user_id: 'u-1',
      conversation_id: 'c-9',
      tools: ['hava_durumu'],
    });
    expect(JSON.stringify(event)).not.toContain('10000000146');
    // The arguments reach the tool masked, on the path a real reply takes.
    // Streamed arguments arrive in pieces, so they have to be joined to be searched.
    const toolArgs: string = stream
      ? res.body
          .split('\n')
          .filter((l) => l.startsWith('data: {'))
          .flatMap((l) => JSON.parse(l.slice(6)).choices ?? [])
          .map((c) => c.delta?.tool_calls?.[0]?.function?.arguments ?? '')
          .join('')
      : res.json().choices[0].message.tool_calls[0].function.arguments;
    expect(res.body).toContain('hava_durumu');
    expect(toolArgs).toContain('TR_TCKN_');
    expect(toolArgs).not.toContain('10000000146');
  });

  it('records nothing for a reply with no tool calls', async () => {
    const logged: unknown[] = [];
    const logger = createLogger('test', {
      level: 'info',
      hooks: {
        logMethod(args, method) {
          logged.push(args[0]);
          method.apply(this, args);
        },
      },
    });
    build(tenant(), { logger });
    await chat({ model: 'auto', messages: [{ role: 'user', content: 'merhaba' }] });
    expect(usage.events.at(-1)?.toolCalls).toEqual([]);
    expect(JSON.stringify(logged)).not.toContain('tool_calls_requested');
  });
});

describe('what the model sends to tools stays masked', () => {
  const PERSON = '⟦PERSON_1⟧';
  const args = JSON.stringify({ q: PERSON });
  const detector = async (text: string): Promise<Span[]> => {
    const i = text.indexOf('Ahmet Yilmaz');
    return i < 0
      ? []
      : [{ type: 'PERSON', start: i, end: i + 12, value: 'Ahmet Yilmaz', score: 0.9 }];
  };
  const payload = { model: 'auto', messages: [{ role: 'user', content: 'Ahmet Yilmaz kim?' }] };

  it('non-streaming: reply text is unmasked, tool arguments are not', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          id: 'x',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `${PERSON} aranıyor`,
                tool_calls: [
                  { id: '1', type: 'function', function: { name: 'ara', arguments: args } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;
    build(tenant(), { piiDetector: detector, fetchImpl });
    const res = await chat(payload);
    const m = res.json().choices[0].message;
    expect(m.content).toBe('Ahmet Yilmaz aranıyor');
    expect(m.tool_calls[0].function.arguments).toBe(args);
    expect(usage.events.at(-1)?.toolCalls).toEqual(['ara']);
  });

  it('streaming: reply text is unmasked, tool arguments are not', async () => {
    const chunk = (delta: object) =>
      `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta }] })}\n\n`;
    const sse =
      chunk({ content: `${PERSON} aranıyor` }) +
      chunk({
        tool_calls: [
          { index: 0, id: '1', type: 'function', function: { name: 'ara', arguments: args } },
        ],
      }) +
      'data: [DONE]\n\n';
    const fetchImpl = (async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as unknown as typeof fetch;
    build(tenant(), { piiDetector: detector, fetchImpl });
    const res = await chat({ ...payload, stream: true });
    expect(res.body).toContain('Ahmet Yilmaz');
    const toolLine = res.body.split('\n').find((l) => l.includes('tool_calls'));
    expect(toolLine).toContain('PERSON_1');
    expect(toolLine).not.toContain('Ahmet');
    expect(usage.events.at(-1)?.toolCalls).toEqual(['ara']);
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
