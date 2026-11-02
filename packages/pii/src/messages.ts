// SPDX-License-Identifier: AGPL-3.0-only
import { detectStructured, resolveOverlaps, type EntityType, type Span } from './detect.js';
import { maskText, type PlaceholderMap } from './mask.js';

export type PiiMode = 'off' | 'mask' | 'block';

export interface PiiPolicy {
  mode: PiiMode;
  /** Per-entity override, e.g. { PERSON: 'off' } for HR tenants. */
  entities?: Partial<Record<EntityType, PiiMode>>;
  /**
   * What happens when the extra detector fails (e.g. analyzer down), so names
   * could go undetected. `allow` (default) sends with structured masking only;
   * `block` rejects the request.
   */
  onDetectorFailure?: 'allow' | 'block';
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
  /** The extra detector failed, so PERSON spans may be missing from `messages`. */
  detectorFailed: boolean;
}

/**
 * Optional extra detector (Presidio NER for PERSON), only called while PERSON is
 * active. Must return spans in `text` coordinates and throw when it can't detect.
 */
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
  if (active.size === 0) return { messages, blocked: [], detectorFailed: false };

  const blocked = new Set<EntityType>();
  let detectorFailed = false;

  const maskOne = async (text: string): Promise<string> => {
    let spans = detectStructured(text, active);
    // After one failure, skip the detector for the rest of the request so an
    // outage costs at most one timeout. The caller applies onDetectorFailure.
    if (extra && !detectorFailed && active.has('PERSON')) {
      try {
        const more = await extra(text);
        spans = resolveOverlaps([...spans, ...more.filter((s) => active.has(s.type))]);
      } catch {
        detectorFailed = true;
      }
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
  return { messages: out, blocked: [...blocked], detectorFailed };
}
