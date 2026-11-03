// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PresidioClient } from '../src/presidio.js';
import type { Span } from '../src/detect.js';

/** Minimal fetch stub: canned JSON responses keyed by call order. */
function fetchStub(
  responses: unknown[],
  opts?: { status?: number; fail?: Error },
): {
  fetch: typeof fetch;
  calls: { url: string; body: unknown }[];
} {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (opts?.fail) throw opts.fail;
    const res = responses[i++] ?? [];
    return new Response(JSON.stringify(res), {
      status: opts?.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

describe('PresidioClient', () => {
  it('maps PERSON results to spans', async () => {
    const { fetch, calls } = fetchStub([
      [{ entity_type: 'PERSON', start: 0, end: 12, score: 0.85 }],
    ]);
    const c = new PresidioClient({ baseUrl: 'http://presidio:3000/', fetchImpl: fetch });
    const spans = await c.detect('Ahmet Yilmaz yarin Ankara');
    expect(spans).toEqual([
      { type: 'PERSON', start: 0, end: 12, value: 'Ahmet Yilmaz', score: 0.85 },
    ] satisfies Span[]);
    expect(calls[0]?.url).toBe('http://presidio:3000/analyze');
    expect(calls[0]?.body).toEqual({
      text: 'Ahmet Yilmaz yarin Ankara',
      language: 'tr',
      entities: ['PERSON'],
    });
  });

  it('drops non-PERSON entities, low scores and out-of-range spans', async () => {
    const { fetch } = fetchStub([
      [
        { entity_type: 'PERSON', start: 0, end: 5, score: 0.2 }, // below minScore
        { entity_type: 'LOCATION', start: 0, end: 6, score: 0.9 }, // unmapped type
        { entity_type: 'PERSON', start: 40, end: 50, score: 0.9 }, // out of range
        { entity_type: 'PERSON', start: 5, end: 5, score: 0.9 }, // empty span
        { entity_type: 'PERSON', start: 6, end: 10, score: 0.9 }, // kept
      ],
    ]);
    const c = new PresidioClient({ baseUrl: 'http://p:3000', fetchImpl: fetch });
    const spans = await c.detect('abcdefg hij');
    expect(spans).toEqual([
      { type: 'PERSON', start: 6, end: 10, value: 'g hi', score: 0.9 },
    ] satisfies Span[]);
  });

  it('throws on fetch errors', async () => {
    const { fetch } = fetchStub([], { fail: new Error('connection refused') });
    const c = new PresidioClient({ baseUrl: 'http://p:3000', fetchImpl: fetch });
    await expect(c.detect('Ahmet burada')).rejects.toThrow('connection refused');
  });

  it('throws on HTTP errors, without the text in the message', async () => {
    const { fetch } = fetchStub([], { status: 500 });
    const c = new PresidioClient({ baseUrl: 'http://p:3000', fetchImpl: fetch });
    await expect(c.detect('Ahmet burada')).rejects.toThrow('analyzer returned HTTP 500');
    await expect(c.detect('Ahmet burada')).rejects.not.toThrow('Ahmet');
  });

  it('throws on malformed responses', async () => {
    const { fetch } = fetchStub([{ not: 'an array item shape' }]);
    const c = new PresidioClient({ baseUrl: 'http://p:3000', fetchImpl: fetch });
    await expect(c.detect('Ahmet burada')).rejects.toThrow('malformed');
  });

  it('skips the network call for text without letters', async () => {
    const { fetch, calls } = fetchStub([]);
    const c = new PresidioClient({ baseUrl: 'http://p:3000', fetchImpl: fetch });
    expect(await c.detect('12345')).toEqual([]);
    expect(await c.detect('')).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
