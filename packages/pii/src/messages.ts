// SPDX-License-Identifier: AGPL-3.0-only
import { detectStructured, resolveOverlaps, type EntityType, type Span } from './detect.js';
import { maskText, type PlaceholderMap } from './mask.js';

export type PiiMode = 'off' | 'mask' | 'block';

export interface PiiPolicy {
  mode: PiiMode;
  /** Per-entity override, e.g. { PERSON: 'off' } for HR tenants. */
  entities?: Partial<Record<EntityType, PiiMode>>;
}

type ContentPart = { type: string; text?: string; [k: string]: unknown };
export interface ChatMessage {
  role: string;
  content: string | ContentPart[] | null;
  [k: string]: unknown;
}

export interface MaskResult {
  messages: ChatMessage[];
  /** Entity types that triggered a block (empty unless some entity is in `block` mode). */
  blocked: EntityType[];
}

/** Optional extra detector (e.g. Presidio NER for PERSON). Must return spans in `text` coordinates. */
export type ExtraDetector = (text: string) => Promise<Span[]>;

const ALL_TYPES: EntityType[] = [
  'TR_TCKN',
  'TR_VKN',
  'TR_IBAN',
  'TR_PHONE',
  'EMAIL_ADDRESS',
  'CREDIT_CARD',
  'PERSON',
];

function effectiveMode(policy: PiiPolicy, type: EntityType): PiiMode {
  return policy.entities?.[type] ?? policy.mode;
}

/**
 * Masks user, system and tool messages. Assistant messages are masked too, because earlier
 * assistant turns were un-masked for the user and would otherwise leak values back to the provider.
 */
export async function maskMessages(
  messages: ChatMessage[],
  policy: PiiPolicy,
  map: PlaceholderMap,
  extra?: ExtraDetector,
): Promise<MaskResult> {
  const active = new Set(ALL_TYPES.filter((t) => effectiveMode(policy, t) !== 'off'));
  if (active.size === 0) return { messages, blocked: [] };

  const blocked = new Set<EntityType>();

  const maskOne = async (text: string): Promise<string> => {
    let spans = detectStructured(text, active);
    if (extra) {
      const more = (await extra(text)).filter((s) => active.has(s.type));
      spans = resolveOverlaps([...spans, ...more]);
    }
    for (const s of spans) if (effectiveMode(policy, s.type) === 'block') blocked.add(s.type);
    return maskText(text, spans, map);
  };

  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ ...m, content: await maskOne(m.content) });
    } else if (Array.isArray(m.content)) {
      const parts: ContentPart[] = [];
      for (const p of m.content) {
        parts.push(
          p.type === 'text' && typeof p.text === 'string'
            ? { ...p, text: await maskOne(p.text) }
            : p,
        );
      }
      out.push({ ...m, content: parts });
    } else {
      out.push(m);
    }
  }
  return { messages: out, blocked: [...blocked] };
}
