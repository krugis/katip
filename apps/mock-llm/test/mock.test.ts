// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildMockApp } from '../src/app.js';

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
});
