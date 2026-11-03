// SPDX-License-Identifier: AGPL-3.0-only
// OpenAI-compatible mock provider for tests and local development (tracker P0-08).
// It echoes the last user message, so tests can check what the gateway sent upstream.
// With tools offered and TOOL_TRIGGER in that message, it calls the first tool instead,
// with the message as the argument, so tests can follow a tool call end to end.
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';

export interface MockOptions {
  /** Model names that always fail with HTTP 500 (to test fallback). */
  failModels?: string[];
  /** Characters per streamed chunk (small values exercise placeholder splitting). */
  chunkSize?: number;
  /** Artificial latency per chunk in ms. */
  delayMs?: number;
}

interface ChatBody {
  model: string;
  stream?: boolean;
  messages: Array<{ role: string; content: unknown }>;
  tools?: Array<{ function?: { name?: string; parameters?: { required?: string[] } } }>;
}

interface EmbeddingBody {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
}

export const TOOL_TRIGGER = '[[use-tool]]';

export interface RecordedRequest {
  headers: Record<string, unknown>;
  body: ChatBody;
}

export interface RecordedEmbedding {
  headers: Record<string, unknown>;
  body: EmbeddingBody;
}

function lastUserText(messages: ChatBody['messages']): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((p: { type?: string; text?: string }) => (p.type === 'text' ? (p.text ?? '') : ''))
      .join(' ');
  }
  return '';
}

const tokens = (s: string) => Math.max(1, Math.ceil(s.length / 4));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BGE-M3's size, so a RAG API sees what it will see from the real one. */
export const MOCK_EMBEDDING_SIZE = 1024;

/**
 * The same text always gets the same vector, and texts sharing words get close ones, so a
 * search finds the right piece of a document without a model.
 */
function mockEmbedding(text: string): number[] {
  const vector = new Array<number>(MOCK_EMBEDDING_SIZE).fill(0);
  for (const word of text.toLocaleLowerCase('tr').match(/[\p{L}\p{N}]+/gu) ?? ['']) {
    const hash = createHash('sha256').update(word).digest();
    vector[hash.readUInt32BE(0) % MOCK_EMBEDDING_SIZE]! += hash[4]! % 2 === 0 ? 1 : -1;
  }
  const length = Math.hypot(...vector);
  if (length === 0) vector[0] = 1;
  return vector.map((n) => (length === 0 ? n : n / length));
}

export function buildMockApp(
  opts: MockOptions = {},
): FastifyInstance & { requests: RecordedRequest[]; embeddingRequests: RecordedEmbedding[] } {
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024,
  }) as unknown as FastifyInstance & {
    requests: RecordedRequest[];
    embeddingRequests: RecordedEmbedding[];
  };
  const fail = new Set(opts.failModels ?? []);
  const chunkSize = opts.chunkSize ?? 6;
  app.requests = [];
  app.embeddingRequests = [];

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/v1/models', async () => ({
    object: 'list',
    data: [{ id: 'mock', object: 'model', owned_by: 'katip' }],
  }));

  app.post<{ Body: ChatBody }>('/v1/chat/completions', async (req, reply) => {
    const body = req.body;
    app.requests.push({ headers: req.headers, body });
    if (fail.has(body.model)) {
      return reply.code(500).send({ error: { message: 'mock failure', type: 'api_error' } });
    }
    const prompt = body.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');
    const text = `Echo: ${lastUserText(body.messages)}`;
    const usage = {
      prompt_tokens: tokens(prompt),
      completion_tokens: tokens(text),
      total_tokens: tokens(prompt) + tokens(text),
    };
    const id = `chatcmpl-mock-${app.requests.length}`;
    const created = Math.floor(Date.now() / 1000);
    const toolName = lastUserText(body.messages).includes(TOOL_TRIGGER)
      ? body.tools?.[0]?.function?.name
      : undefined;
    // The name the tool asks for, as LibreChat checks a tool's arguments before running it.
    const argName = body.tools?.[0]?.function?.parameters?.required?.[0] ?? 'q';
    const toolArgs = JSON.stringify({ [argName]: lastUserText(body.messages) });

    if (!body.stream && toolName) {
      return {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_mock',
                  type: 'function',
                  function: { name: toolName, arguments: toolArgs },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage,
      };
    }

    if (!body.stream) {
      return {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage,
      };
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant' } }],
    });
    if (toolName) {
      // Name first, then the arguments in pieces, as real providers stream them.
      const toolDelta = (fn: object, extra: object = {}) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...extra, function: fn }] } }],
      });
      send(toolDelta({ name: toolName, arguments: '' }, { id: 'call_mock', type: 'function' }));
      for (let i = 0; i < toolArgs.length; i += chunkSize) {
        send(toolDelta({ arguments: toolArgs.slice(i, i + chunkSize) }));
      }
    }
    for (let i = 0; !toolName && i < text.length; i += chunkSize) {
      if (opts.delayMs) await sleep(opts.delayMs);
      send({
        id,
        object: 'chat.completion.chunk',
        created,
        model: body.model,
        choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) } }],
      });
    }
    send({
      id,
      object: 'chat.completion.chunk',
      created,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: toolName ? 'tool_calls' : 'stop' }],
    });
    send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage });
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });

  app.post<{ Body: EmbeddingBody }>('/v1/embeddings', async (req, reply) => {
    const body = req.body;
    app.embeddingRequests.push({ headers: req.headers, body });
    if (fail.has(body.model)) {
      return reply.code(500).send({ error: { message: 'mock failure', type: 'api_error' } });
    }
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const used = inputs.reduce((a, s) => a + tokens(s), 0);
    return {
      object: 'list',
      model: body.model,
      data: inputs.map((text, index) => {
        const vector = mockEmbedding(text);
        return {
          object: 'embedding',
          index,
          embedding:
            body.encoding_format === 'base64'
              ? Buffer.from(new Float32Array(vector).buffer).toString('base64')
              : vector,
        };
      }),
      usage: { prompt_tokens: used, total_tokens: used },
    };
  });

  return app;
}
