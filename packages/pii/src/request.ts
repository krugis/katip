// SPDX-License-Identifier: AGPL-3.0-only
import type { PlaceholderMap } from './mask.js';
import { createMasker, type ExtraDetector, type Masker, type PiiPolicy } from './messages.js';
import type { EntityType } from './detect.js';

/**
 * Everything a chat request may carry to a provider. The gateway is the one control
 * point for LLM calls, including those made for user-added MCP tools and generated
 * flows, so this is an allow list: a field not listed here never leaves. The gateway
 * sets `user` and `metadata` itself.
 */
const SCALAR_FIELDS = new Set([
  'model',
  'stream',
  'stream_options',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'n',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'logprobs',
  'top_logprobs',
  'parallel_tool_calls',
  'reasoning_effort',
  'verbosity',
]);
/** Fields holding free text somewhere inside: every string value in them gets scanned. */
const SCANNED_FIELDS = new Set([
  'tools',
  'functions',
  'tool_choice',
  'function_call',
  'response_format',
  'stop',
  'thinking',
  'reasoning',
]);
const GATEWAY_FIELDS = new Set(['messages', 'user', 'metadata']);
const MESSAGE_FIELDS = new Set([
  'role',
  'content',
  'name',
  'tool_calls',
  'tool_call_id',
  'function_call',
  'refusal',
]);
/** Identifiers in schemas and tool definitions, which a placeholder would break. */
const IDENTIFIER_KEYS = new Set(['type', 'name', '$ref', 'format', 'pattern', 'strict']);

export interface MaskRequestResult {
  body: Record<string, unknown>;
  /** Entity types that triggered a block. */
  blocked: EntityType[];
  detectorFailed: boolean;
  /** Names of what was dropped. Field names only, never values. */
  dropped: string[];
  /** Images, files and audio sent unscanned, by part type. See LLD-03 §5. */
  nonTextParts: Record<string, number>;
}

type Part = Record<string, unknown> & { type?: unknown };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Field names are logged, so anything that doesn't look like one is not repeated. */
const safeName = (name: string): string =>
  /^[A-Za-z0-9_.:-]{1,40}$/.test(name) ? name : '<other>';

/** Applies `edit` to every string value in `value`, leaving keys and identifiers alone. */
function mapStrings(value: unknown, edit: (s: string) => string): unknown {
  if (typeof value === 'string') return edit(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, edit));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = IDENTIFIER_KEYS.has(k) ? v : mapStrings(v, edit);
  }
  return out;
}

async function maskToolCall(call: unknown, masker: Masker): Promise<unknown> {
  if (!isRecord(call)) return call;
  const fn = isRecord(call['function']) ? call['function'] : call;
  const args = fn['arguments'];
  if (typeof args !== 'string') return call;
  const masked = { ...fn, arguments: await masker.maskOne(args) };
  return isRecord(call['function']) ? { ...call, function: masked } : masked;
}

async function maskPart(
  part: Part,
  masker: Masker,
  result: MaskRequestResult,
): Promise<Part | null> {
  const type = typeof part.type === 'string' ? part.type : '';
  if ((type === 'text' || type === 'input_text') && typeof part['text'] === 'string') {
    return { type, text: await masker.maskOne(part['text']) };
  }
  if (type === 'refusal' && typeof part['refusal'] === 'string') {
    return { type, refusal: await masker.maskOne(part['refusal']) };
  }
  if (type === 'image_url' || type === 'input_audio') {
    result.nonTextParts[type] = (result.nonTextParts[type] ?? 0) + 1;
    return part;
  }
  if (type === 'file') {
    result.nonTextParts[type] = (result.nonTextParts[type] ?? 0) + 1;
    const file = part['file'];
    if (isRecord(file) && typeof file['filename'] === 'string') {
      return { ...part, file: { ...file, filename: await masker.maskOne(file['filename']) } };
    }
    return part;
  }
  result.dropped.push(`content:${safeName(type)}`);
  return null;
}

async function maskMessage(
  message: unknown,
  masker: Masker,
  result: MaskRequestResult,
): Promise<Record<string, unknown>> {
  const m = isRecord(message) ? message : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (MESSAGE_FIELDS.has(k)) out[k] = v;
    else result.dropped.push(`message.${safeName(k)}`);
  }
  if (typeof out['content'] === 'string') {
    out['content'] = await masker.maskOne(out['content']);
  } else if (Array.isArray(out['content'])) {
    const parts: Part[] = [];
    for (const p of out['content']) {
      const masked = isRecord(p) ? await maskPart(p, masker, result) : null;
      if (masked) parts.push(masked);
    }
    out['content'] = parts;
  }
  if (typeof out['name'] === 'string') {
    // Providers only accept identifiers here, so a name holding personal data goes.
    if ((await masker.maskOne(out['name'])) !== out['name']) delete out['name'];
  }
  if (typeof out['refusal'] === 'string') out['refusal'] = await masker.maskOne(out['refusal']);
  if (Array.isArray(out['tool_calls'])) {
    const calls: unknown[] = [];
    for (const c of out['tool_calls']) calls.push(await maskToolCall(c, masker));
    out['tool_calls'] = calls;
  }
  if (out['function_call'] !== undefined) {
    out['function_call'] = await maskToolCall(out['function_call'], masker);
  }
  return out;
}

/**
 * Builds what may leave for the provider from a chat request: drops anything not on the
 * allow lists, and masks every string that can carry text, including tool results, earlier
 * tool-call arguments and tool definitions. Images, files and audio pass unscanned for now,
 * counted in `nonTextParts`.
 */
export async function maskChatRequest(
  body: Record<string, unknown>,
  policy: PiiPolicy,
  map: PlaceholderMap,
  extra?: ExtraDetector,
): Promise<MaskRequestResult> {
  const masker = createMasker(policy, map, extra);
  const result: MaskRequestResult = {
    body: {},
    blocked: [],
    detectorFailed: false,
    dropped: [],
    nonTextParts: {},
  };

  const messages: unknown[] = [];
  for (const m of Array.isArray(body['messages']) ? body['messages'] : []) {
    messages.push(await maskMessage(m, masker, result));
  }

  // Scanned together: one request can hold hundreds of strings across its tool
  // definitions, and one detector call per string would cost seconds on every turn.
  const scanned: [string, unknown][] = [];
  const texts: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (SCALAR_FIELDS.has(k)) {
      result.body[k] = v;
    } else if (SCANNED_FIELDS.has(k)) {
      scanned.push([k, v]);
      mapStrings(v, (s) => {
        texts.push(s);
        return s;
      });
    } else if (!GATEWAY_FIELDS.has(k)) {
      result.dropped.push(safeName(k));
    }
  }
  const maskedTexts = await masker.maskMany(texts);
  let next = 0;
  for (const [k, v] of scanned) {
    result.body[k] = mapStrings(v, () => maskedTexts[next++] ?? '');
  }

  result.body['messages'] = messages;
  result.blocked = masker.blocked();
  result.detectorFailed = masker.detectorFailed();
  return result;
}

/** All an embedding request may carry to a provider, besides the text. Same rule as above. */
const EMBEDDING_FIELDS = new Set(['model', 'encoding_format', 'dimensions']);

/**
 * Builds what may leave for the provider from an embedding request. Each string is checked on
 * its own rather than through `maskMany`: an upload holds hundreds of chunks, cut wherever
 * they fell, and the two sides of a cut joined into one text could hide a name from both.
 * `input` holds text only: token arrays can't be scanned, so the gateway refuses them first.
 */
export async function maskEmbeddingRequest(
  body: Record<string, unknown> & { input: string | string[] },
  policy: PiiPolicy,
  map: PlaceholderMap,
  extra?: ExtraDetector,
): Promise<MaskRequestResult> {
  const masker = createMasker(policy, map, extra);
  const result: MaskRequestResult = {
    body: {},
    blocked: [],
    detectorFailed: false,
    dropped: [],
    nonTextParts: {},
  };
  for (const [k, v] of Object.entries(body)) {
    if (EMBEDDING_FIELDS.has(k)) result.body[k] = v;
    else if (!GATEWAY_FIELDS.has(k) && k !== 'input') result.dropped.push(safeName(k));
  }
  if (typeof body.input === 'string') {
    result.body['input'] = await masker.maskOne(body.input);
  } else {
    const masked: string[] = [];
    for (const text of body.input) masked.push(await masker.maskOne(text));
    result.body['input'] = masked;
  }
  result.blocked = masker.blocked();
  result.detectorFailed = masker.detectorFailed();
  return result;
}
