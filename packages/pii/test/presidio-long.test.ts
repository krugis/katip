// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi } from 'vitest';
import { PresidioClient, splitForAnalysis } from '../src/index.js';

/** An analyzer that finds `name` wherever it appears, and counts how often it's asked. */
function analyzer(name: string, score = 0.9) {
  const asked: string[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const { text } = JSON.parse(String(init?.body)) as { text: string };
    asked.push(text);
    const found = [];
    for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
      found.push({ entity_type: 'PERSON', start: at, end: at + name.length, score });
    }
    return new Response(JSON.stringify(found), { status: 200 });
  }) as unknown as typeof fetch;
  return { asked, fetchImpl };
}

describe('splitForAnalysis', () => {
  it('leaves short text alone', () => {
    expect(splitForAnalysis('kısa metin', 100)).toEqual([{ start: 0, text: 'kısa metin' }]);
  });

  it('loses nothing, and gives each piece its real position', () => {
    const text = 'Bir cümle burada bitiyor. '.repeat(400);
    const chunks = splitForAnalysis(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(500);
      expect(text.slice(c.start, c.start + c.text.length)).toBe(c.text);
    }
  });

  it('prefers a line end, then a sentence end, then a space', () => {
    const line = `${'a'.repeat(300)}\n${'b'.repeat(300)}`;
    expect(splitForAnalysis(line, 400)[0]!.text.endsWith('\n')).toBe(true);
    const sentence = `${'a '.repeat(150)}son. ${'b '.repeat(150)}`;
    expect(splitForAnalysis(sentence, 400)[0]!.text.endsWith('son. ')).toBe(true);
    const words = 'kelime '.repeat(200);
    expect(splitForAnalysis(words, 400)[0]!.text.endsWith(' ')).toBe(true);
  });

  it('cuts text with no spaces at the limit, never inside a character', () => {
    const text = '😀'.repeat(300);
    const chunks = splitForAnalysis(text, 401);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    for (const c of chunks) expect(c.text.length % 2).toBe(0);
  });

  it('keeps earlier pieces the same when the text grows at the end', () => {
    const text = 'Satış raporu hazırlandı.\n'.repeat(200);
    const before = splitForAnalysis(text, 500);
    const after = splitForAnalysis(`${text}Yeni mesaj.`, 500);
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });
});

describe('PresidioClient on long text', () => {
  const NAME = 'Ayşe Yılmaz';
  const longText = `${'Toplantı yapıldı.\n'.repeat(300)}${NAME} geldi.\n${'Rapor yazıldı.\n'.repeat(300)}`;

  it('finds a name at its real position in a later piece', async () => {
    const { asked, fetchImpl } = analyzer(NAME);
    const client = new PresidioClient({ baseUrl: 'http://a', fetchImpl });
    const spans = await client.detect(longText);
    expect(asked.length).toBeGreaterThan(1);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.start).toBe(longText.indexOf(NAME));
    expect(spans[0]!.value).toBe(NAME);
  });

  it('only asks about the new part on the next turn', async () => {
    const { asked, fetchImpl } = analyzer(NAME);
    const client = new PresidioClient({ baseUrl: 'http://a', fetchImpl });
    await client.detect(longText);
    const first = asked.length;
    const spans = await client.detect(`${longText}Yeni mesaj.`);
    expect(asked.length).toBe(first + 1);
    expect(spans.map((s) => s.value)).toEqual([NAME]);
  });

  it('fails the whole text when one piece fails, and asks no more', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 2) return new Response('no', { status: 500 });
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const client = new PresidioClient({ baseUrl: 'http://a', fetchImpl, concurrency: 1 });
    await expect(client.detect(longText)).rejects.toThrow('HTTP 500');
    expect(calls).toBe(2);
  });

  it('remembers nothing after a failure', async () => {
    let healthy = false;
    const fetchImpl = vi.fn(async () =>
      healthy ? new Response('[]', { status: 200 }) : new Response('no', { status: 500 }),
    ) as unknown as typeof fetch;
    const client = new PresidioClient({ baseUrl: 'http://a', fetchImpl });
    await expect(client.detect('Ayşe geldi')).rejects.toThrow();
    healthy = true;
    await expect(client.detect('Ayşe geldi')).resolves.toEqual([]);
  });
});

describe('PresidioClient spans', () => {
  it('keeps a surname the model is unsure of, as one name', async () => {
    const text = 'Ahmet Yılmaz bugün gelmedi.';
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { entity_type: 'PERSON', start: 0, end: 5, score: 0.99 },
            { entity_type: 'PERSON', start: 6, end: 12, score: 0.48 },
          ]),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const spans = await new PresidioClient({ baseUrl: 'http://a', fetchImpl }).detect(text);
    expect(spans).toEqual([
      { type: 'PERSON', start: 0, end: 12, value: 'Ahmet Yılmaz', score: 0.48 },
    ]);
  });

  it('does not join two names across a line break', async () => {
    const text = 'Ahmet\nYılmaz';
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            { entity_type: 'PERSON', start: 0, end: 5, score: 0.9 },
            { entity_type: 'PERSON', start: 6, end: 12, score: 0.9 },
          ]),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const spans = await new PresidioClient({ baseUrl: 'http://a', fetchImpl }).detect(text);
    expect(spans.map((s) => s.value)).toEqual(['Ahmet', 'Yılmaz']);
  });
});
