// SPDX-License-Identifier: AGPL-3.0-only
import type { EntityType, Span } from './detect.js';

export const PLACEHOLDER_OPEN = '⟦';
export const PLACEHOLDER_CLOSE = '⟧';
const PLACEHOLDER_RE = /⟦([A-Z_]+_\d+)⟧/g;
/** Longest possible placeholder; used to bound the streaming buffer. */
const MAX_PLACEHOLDER = 48;

/**
 * Per-request mapping between original values and placeholders.
 * The same value gets the same placeholder across all messages of one request,
 * so the model can still reason about "the same person / the same IBAN".
 * Lives in request memory only; never persisted or logged.
 */
export class PlaceholderMap {
  private readonly byValue = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<EntityType, number>();

  placeholderFor(type: EntityType, value: string): string {
    const key = `${type}\u0000${normalise(type, value)}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const ph = `${PLACEHOLDER_OPEN}${type}_${n}${PLACEHOLDER_CLOSE}`;
    this.byValue.set(key, ph);
    this.byPlaceholder.set(ph, value);
    return ph;
  }

  original(placeholder: string): string | undefined {
    return this.byPlaceholder.get(placeholder);
  }

  get size(): number {
    return this.byPlaceholder.size;
  }

  /** Counts per entity type, safe to log (no values). */
  counts(): Partial<Record<EntityType, number>> {
    return Object.fromEntries(this.counters) as Partial<Record<EntityType, number>>;
  }
}

function normalise(type: EntityType, value: string): string {
  if (type === 'EMAIL_ADDRESS') return value.toLowerCase();
  if (type === 'PERSON') return value.trim();
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/** Replaces spans (non-overlapping, any order) with placeholders. */
export function maskText(text: string, spans: Span[], map: PlaceholderMap): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const s of ordered) {
    if (s.start < pos) continue;
    out += text.slice(pos, s.start) + map.placeholderFor(s.type, s.value);
    pos = s.end;
  }
  return out + text.slice(pos);
}

/** Restores placeholders in a complete text. Unknown placeholders are left as they are. */
export function unmaskText(text: string, map: PlaceholderMap): string {
  return text.replace(PLACEHOLDER_RE, (ph) => map.original(ph) ?? ph);
}

/**
 * Restores placeholders in a token stream. A placeholder can be split across chunks
 * ("⟦TR_" + "IBAN_1⟧"), so text after an unclosed "⟦" is held back until it closes
 * or grows beyond the maximum placeholder length.
 */
export class StreamingUnmasker {
  private buffer = '';

  constructor(private readonly map: PlaceholderMap) {}

  push(chunk: string): string {
    this.buffer += chunk;
    const open = this.buffer.lastIndexOf(PLACEHOLDER_OPEN);
    if (open === -1 || this.buffer.indexOf(PLACEHOLDER_CLOSE, open) !== -1) {
      return this.drain(this.buffer.length);
    }
    if (this.buffer.length - open > MAX_PLACEHOLDER) {
      return this.drain(this.buffer.length);
    }
    return this.drain(open);
  }

  flush(): string {
    return this.drain(this.buffer.length);
  }

  private drain(upTo: number): string {
    const ready = this.buffer.slice(0, upTo);
    this.buffer = this.buffer.slice(upTo);
    return unmaskText(ready, this.map);
  }
}
