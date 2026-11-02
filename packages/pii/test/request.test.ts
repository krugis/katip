// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { PlaceholderMap, maskChatRequest, type PiiPolicy } from '../src/index.js';

const TCKN = '10000000146';
const secret = `Ayşe Yılmaz, TCKN ${TCKN}`;
const person = async (text: string) => {
  const name = 'Ayşe Yılmaz';
  const spans = [];
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    spans.push({
      type: 'PERSON' as const,
      start: i,
      end: i + name.length,
      value: name,
      score: 0.9,
    });
  }
  return spans;
};
const run = (body: Record<string, unknown>, policy: PiiPolicy = { mode: 'mask' }, extra = person) =>
  maskChatRequest(body, policy, new PlaceholderMap(), extra);
const leaks = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.includes(TCKN) || s.includes('Ayşe') || s.includes('Yılmaz');
};
const user = { role: 'user', content: 'merhaba' };

describe('maskChatRequest: text never leaves unmasked', () => {
  it.each<[string, Record<string, unknown>]>([
    ['user message', { messages: [{ role: 'user', content: secret }] }],
    ['text part', { messages: [{ role: 'user', content: [{ type: 'text', text: secret }] }] }],
    ['tool result', { messages: [{ role: 'tool', tool_call_id: '1', content: secret }] }],
    [
      'earlier tool-call arguments',
      {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: '1',
                type: 'function',
                function: { name: 'ara', arguments: `{"q":"${secret}"}` },
              },
            ],
          },
        ],
      },
    ],
    [
      'legacy function_call arguments',
      {
        messages: [
          { role: 'assistant', content: null, function_call: { name: 'ara', arguments: secret } },
        ],
      },
    ],
    [
      'tool definition',
      {
        messages: [user],
        tools: [
          {
            type: 'function',
            function: {
              name: 'ara',
              description: secret,
              parameters: {
                type: 'object',
                properties: { q: { type: 'string', description: secret, enum: [secret] } },
              },
            },
          },
        ],
      },
    ],
    ['message name', { messages: [{ role: 'user', name: secret, content: 'x' }] }],
    [
      'file name',
      {
        messages: [
          { role: 'user', content: [{ type: 'file', file: { filename: `${secret}.pdf` } }] },
        ],
      },
    ],
    [
      'response schema',
      {
        messages: [user],
        response_format: { type: 'json_schema', json_schema: { schema: { description: secret } } },
      },
    ],
    ['stop string', { messages: [user], stop: [secret] }],
  ])('%s', async (_label, body) => {
    const r = await run(body);
    expect(leaks(r.body)).toBe(false);
  });

  it('keeps JSON arguments valid when masking them', async () => {
    const r = await run({
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: '1', function: { name: 'ara', arguments: `{"q":"${secret}"}` } }],
        },
      ],
    });
    const m = (r.body['messages'] as { tool_calls: { function: { arguments: string } }[] }[])[0]!;
    expect(JSON.parse(m.tool_calls[0]!.function.arguments)).toEqual({
      q: '⟦PERSON_1⟧, TCKN ⟦TR_TCKN_1⟧',
    });
  });

  it('leaves tool names and schema identifiers usable', async () => {
    const r = await run({
      messages: [user],
      tools: [
        {
          type: 'function',
          function: { name: 'ara', parameters: { type: 'object', format: 'date', $ref: '#/x' } },
        },
      ],
    });
    expect(r.body['tools']).toEqual([
      {
        type: 'function',
        function: { name: 'ara', parameters: { type: 'object', format: 'date', $ref: '#/x' } },
      },
    ]);
  });

  it('honours block mode for text found outside messages', async () => {
    const r = await run(
      { messages: [user], tools: [{ function: { description: `TCKN ${TCKN}` } }] },
      { mode: 'block' },
    );
    expect(r.blocked).toContain('TR_TCKN');
  });
});

describe('maskChatRequest: allow list', () => {
  it('drops unknown fields and reports their names, not values', async () => {
    const r = await run({
      messages: [user],
      custom_field: secret,
      metadata: { note: secret },
      user: secret,
      prediction: { content: secret },
      'x y': secret,
    });
    expect(leaks(r.body)).toBe(false);
    expect(Object.keys(r.body)).toEqual(['messages']);
    expect(r.dropped).toEqual(['custom_field', 'prediction', '<other>']);
    expect(leaks(r.dropped)).toBe(false);
  });

  it('keeps the settings providers need', async () => {
    const r = await run({
      model: 'auto',
      messages: [user],
      stream: true,
      temperature: 0.2,
      max_tokens: 10,
      tool_choice: 'auto',
    });
    expect(r.body).toMatchObject({
      model: 'auto',
      stream: true,
      temperature: 0.2,
      max_tokens: 10,
      tool_choice: 'auto',
    });
    expect(r.dropped).toEqual([]);
  });

  it('drops unknown message fields and content parts', async () => {
    const r = await run({
      messages: [{ role: 'user', content: [{ type: 'mystery', text: secret }], note: secret }],
    });
    expect(leaks(r.body)).toBe(false);
    expect(r.dropped).toEqual(['message.note', 'content:mystery']);
  });

  it('drops extra fields on text parts', async () => {
    const r = await run({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', extra: secret }] }],
    });
    expect(leaks(r.body)).toBe(false);
  });
});

describe('maskChatRequest: images and files are allowed for now (LLD-03 §5)', () => {
  it('passes them unscanned and counts them', async () => {
    const image = { type: 'image_url', image_url: { url: 'https://x.test/a.png' } };
    const file = { type: 'file', file: { filename: 'rapor.pdf', file_data: 'QUJD' } };
    const audio = { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } };
    const r = await run({ messages: [{ role: 'user', content: [image, file, audio] }] });
    const m = (r.body['messages'] as { content: unknown[] }[])[0]!;
    expect(m.content).toEqual([image, file, audio]);
    expect(r.nonTextParts).toEqual({ image_url: 1, file: 1, input_audio: 1 });
  });
});

describe('maskChatRequest: name detection', () => {
  it('calls the detector once for all tool definitions', async () => {
    let calls = 0;
    const counting = async (text: string) => {
      calls += 1;
      return person(text);
    };
    const tools = Array.from({ length: 50 }, (_, i) => ({
      function: {
        name: `t${i}`,
        description: i === 7 ? 'Ayşe Yılmaz için' : `araç ${i}`,
        parameters: { properties: { q: { description: 'sorgu' } } },
      },
    }));
    const r = await run(
      { messages: [{ role: 'user', content: 'x' }], tools },
      { mode: 'mask' },
      counting,
    );
    expect(calls).toBe(2); // one message + one batch
    expect(leaks(r.body)).toBe(false);
    const out = r.body['tools'] as { function: { description: string } }[];
    expect(out[7]!.function.description).toBe('⟦PERSON_1⟧ için');
    expect(out[8]!.function.description).toBe('araç 8');
  });

  it('reports a failed detector for tool definitions too', async () => {
    const down = async () => {
      throw new Error('analyzer down');
    };
    const r = await run(
      { messages: [], tools: [{ function: { description: `TCKN ${TCKN}` } }] },
      { mode: 'mask' },
      down,
    );
    expect(r.detectorFailed).toBe(true);
    expect(leaks(r.body)).toBe(false);
  });

  it('does not change anything when masking is off, but still applies the allow list', async () => {
    const r = await run(
      { messages: [{ role: 'user', content: secret }], custom: 1 },
      { mode: 'off' },
    );
    expect(r.body['messages']).toEqual([{ role: 'user', content: secret }]);
    expect(r.dropped).toEqual(['custom']);
  });
});
