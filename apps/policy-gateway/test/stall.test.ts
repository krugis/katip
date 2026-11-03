// SPDX-License-Identifier: AGPL-3.0-only
// A provider that goes quiet (tracker P0-08). Real sockets, because what matters is what
// happens to a body that stops arriving.
import { createServer, type Server } from 'node:http';
import { DEFAULT_POLICY } from '@katip/policy-engine';
import { createLogger } from '@katip/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/app.js';
import { GatewayMetrics } from '../src/metrics.js';
import {
  MemoryQuotaStore,
  MemoryTenantStore,
  MemoryUsageSink,
  type Tenant,
} from '../src/stores.js';

const KEY = 'sk-katip-acme-test';
const EMAIL = 'ayse@acme.com.tr';
const TIMEOUT_MS = 300;

type Behaviour = 'no-headers' | 'stall-body' | 'stall-stream' | 'slow-but-alive';
let behaviour: Behaviour = 'no-headers';
let calls: string[] = [];

const chunk = (content: string) =>
  `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { content } }],
  })}\n\n`;

let upstream: Server;
let url: string;
const open = new Set<import('node:http').ServerResponse>();

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      calls.push((JSON.parse(raw) as { model: string }).model);
      open.add(res);
      res.on('close', () => open.delete(res));
      if (behaviour === 'no-headers') return;
      if (behaviour === 'stall-body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"choices":[');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk('Merhaba '));
      if (behaviour === 'stall-stream') return;
      // Slower overall than the timeout, but never quiet for that long.
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        res.write(chunk(`${sent} `));
        if (sent === 6) {
          clearInterval(timer);
          res.write(
            `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 6 } })}\n\ndata: [DONE]\n\n`,
          );
          res.end();
        }
      }, TIMEOUT_MS / 3);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const addr = upstream.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
});
afterEach(() => {
  for (const res of open) res.destroy();
});
afterAll(async () => {
  await new Promise((r) => upstream.close(r));
});

const acme: Tenant = {
  id: 't-acme',
  slug: 'acme',
  status: 'active',
  policy: { ...DEFAULT_POLICY },
  pii: { mode: 'mask' },
  kvkkAddon: false,
  limits: { standard: 1_000_000, premium: 100_000 },
};

function build() {
  const tenants = new MemoryTenantStore();
  tenants.addTenant({ ...acme }, [KEY]);
  tenants.addUser({ id: 'u-1', tenantId: acme.id, email: EMAIL, status: 'active' });
  const quota = new MemoryQuotaStore();
  const usage = new MemoryUsageSink();
  const metrics = new GatewayMetrics();
  calls = [];
  const gw: FastifyInstance = buildGateway({
    litellmBaseUrl: url,
    litellmApiKey: 'test',
    tenants,
    quota,
    usage,
    metrics,
    upstreamTimeoutMs: TIMEOUT_MS,
    logger: createLogger('test', { level: 'silent' }),
  });
  return { gw, quota, usage, metrics };
}

const say = (extra: object = {}) => ({
  model: 'fast',
  messages: [{ role: 'user', content: 'Selam' }],
  ...extra,
});
const send = (gw: FastifyInstance, payload: object) =>
  gw.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: `Bearer ${KEY}`, 'x-user-email': EMAIL },
    payload,
  });

/** Fails rather than hanging the test run, which is the bug these look for. */
const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('still hanging')), ms)),
  ]);

describe('a provider that goes quiet', () => {
  it('moves on from one that never answers, then gives up with an error', async () => {
    behaviour = 'no-headers';
    const { gw, metrics } = build();
    const res = await within(5000, send(gw, say()));
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json().error).toBeDefined();
    expect(calls.length).toBeGreaterThan(1);
    expect(await metrics.registry.metrics()).toMatch(/gw_upstream_errors_total\{model="[^"]+"\} 1/);
  });

  it('does not hang on a reply that stops part-way', async () => {
    behaviour = 'stall-body';
    const { gw } = build();
    const res = await within(5000, send(gw, say()));
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    expect(res.json().error).toBeDefined();
  });

  it('ends a stream that stops part-way, keeping what was sent', async () => {
    behaviour = 'stall-stream';
    const { gw, usage, metrics } = build();
    const res = await within(5000, send(gw, say({ stream: true })));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Merhaba');
    expect(res.body).toContain('upstream_stalled');
    expect(res.body).toContain('data: [DONE]');
    expect(usage.events).toHaveLength(1);
    expect(await metrics.registry.metrics()).toMatch(/gw_upstream_errors_total\{model="[^"]+"\} 1/);
  });

  it('gives back the quota it held', async () => {
    behaviour = 'stall-body';
    const { gw, quota } = build();
    await within(5000, send(gw, say()));
    expect(quota.usedOf(acme.id, 'standard')).toBe(0);
    behaviour = 'stall-stream';
    await within(5000, send(gw, say({ stream: true })));
    expect(quota.usedOf(acme.id, 'standard')).toBe(0);
  });

  it('leaves a slow stream alone while it is still sending', async () => {
    behaviour = 'slow-but-alive';
    const { gw } = build();
    const started = Date.now();
    const res = await within(5000, send(gw, say({ stream: true })));
    expect(Date.now() - started).toBeGreaterThan(TIMEOUT_MS);
    expect(res.body).toContain('data: [DONE]');
    expect(res.body).not.toContain('upstream_stalled');
    for (const n of [1, 6]) expect(res.body).toContain(`${n} `);
  });
});
