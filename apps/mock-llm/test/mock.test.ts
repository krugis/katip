// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { MOCK_EMBEDDING_SIZE, buildMockApp } from '../src/app.js';

describe('mock-llm', () => {
  it('echoes the last user message', async () => {
    const app = buildMockApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'Merhaba' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().choices[0].message.content).toBe('Echo: Merhaba');
    expect(app.requests).toHaveLength(1);
  });

  it('streams SSE chunks and a usage chunk', async () => {
    const app = buildMockApp({ chunkSize: 3 });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'abc' }] },
    });
    const lines = res.body.split('\n\n').filter(Boolean);
    expect(lines.at(-1)).toBe('data: [DONE]');
    const text = lines
      .filter((l) => l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)))
      .map((c) => c.choices[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Echo: abc');
  });

  it('fails configured models', async () => {
    const app = buildMockApp({ failModels: ['bad'] });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'bad', messages: [] },
    });
    expect(res.statusCode).toBe(500);
  });

  it('calls a tool with the argument it asks for', async () => {
    const app = buildMockApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        messages: [{ role: 'user', content: '[[use-tool]] kira' }],
        tools: [{ function: { name: 'file_search', parameters: { required: ['query'] } } }],
      },
    });
    const call = res.json().choices[0].message.tool_calls[0].function;
    expect(call.name).toBe('file_search');
    expect(JSON.parse(call.arguments)).toEqual({ query: '[[use-tool]] kira' });
  });

  describe('embeddings', () => {
    const embed = async (input: string | string[], extra: object = {}) => {
      const res = await buildMockApp().inject({
        method: 'POST',
        url: '/v1/embeddings',
        payload: { model: 'm', input, ...extra },
      });
      return res.json();
    };
    const vector = async (text: string): Promise<number[]> => (await embed(text)).data[0].embedding;
    const similarity = (a: number[], b: number[]) => a.reduce((sum, n, i) => sum + n * b[i]!, 0);

    it('gives the same text the same vector, of unit length', async () => {
      const a = await vector('kira sözleşmesi');
      expect(a).toHaveLength(MOCK_EMBEDDING_SIZE);
      expect(a).toEqual(await vector('kira sözleşmesi'));
      expect(similarity(a, a)).toBeCloseTo(1);
      expect(await vector('')).toHaveLength(MOCK_EMBEDDING_SIZE);
    });

    it('puts texts sharing words closer, so a search finds the right piece', async () => {
      const doc = await vector('ankara şubesi kira sözleşmesi 2027');
      const near = await vector('kira sözleşmesi ankara');
      const far = await vector('yıllık izin listesi personel');
      expect(similarity(doc, near)).toBeGreaterThan(similarity(doc, far));
    });

    it('answers each input in order, with its usage', async () => {
      const json = await embed(['bir', 'iki']);
      expect(json.data.map((d: { index: number }) => d.index)).toEqual([0, 1]);
      expect(json.usage.prompt_tokens).toBeGreaterThan(0);
      expect(json.usage.total_tokens).toBe(json.usage.prompt_tokens);
    });

    it('answers base64 when asked, as the OpenAI client does', async () => {
      const json = await embed('kira', { encoding_format: 'base64' });
      const bytes = Buffer.from(json.data[0].embedding, 'base64');
      expect(bytes.length).toBe(MOCK_EMBEDDING_SIZE * 4);
    });
  });
});
