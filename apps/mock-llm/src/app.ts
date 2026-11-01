// SPDX-License-Identifier: AGPL-3.0-only
// OpenAI-compatible mock provider for tests and local development (tracker P0-08).
// It echoes the last user message, so tests can check what the gateway sent upstream.
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
}

export interface RecordedRequest {
  headers: Record<string, unknown>;
  body: ChatBody;
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

export function buildMockApp(
  opts: MockOptions = {},
): FastifyInstance & { requests: RecordedRequest[] } {
  const app = Fastify({ logger: false }) as unknown as FastifyInstance & {
    requests: RecordedRequest[];
  };
  const fail = new Set(opts.failModels ?? []);
  const chunkSize = opts.chunkSize ?? 6;
  app.requests = [];

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
    for (let i = 0; i < text.length; i += chunkSize) {
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
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage });
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });

  app.post<{ Body: { model: string; input: string | string[] } }>('/v1/embeddings', async (req) => {
    const inputs = Array.isArray(req.body.input) ? req.body.input : [req.body.input];
    return {
      object: 'list',
      model: req.body.model,
      data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: [0.1, 0.2, 0.3] })),
      usage: { prompt_tokens: inputs.reduce((a, s) => a + tokens(s), 0), total_tokens: 0 },
    };
  });

  return app;
}
