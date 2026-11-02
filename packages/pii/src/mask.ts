// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import type { EntityType, Span } from './detect.js';

export const PLACEHOLDER_OPEN = '⟦';
export const PLACEHOLDER_CLOSE = '⟧';
const PLACEHOLDER_RE = /⟦[A-Z_]+_[0-9a-f]+⟧/g;
/** Longest possible placeholder; used to bound the streaming buffer. */
const MAX_PLACEHOLDER = 48;

/** Token for a normalised value; `length` grows only if a token is already taken. */
export type PlaceholderToken = (type: EntityType, normalised: string, length: number) => string;

/**
 * Tokens that stay the same for a value throughout a conversation, across requests,
 * with nothing stored: earlier tool-call arguments and tool results come back holding
 * placeholders, which must keep meaning the same value. They are keyed, so a provider
 * can't guess a TCKN from its token, and per conversation, so tokens can't be linked
 * across conversations or tenants.
 */
export function conversationTokens(
  key: string,
  tenantId: string,
  conversationId: string,
): PlaceholderToken {
  return (type, normalised, length) =>
    createHmac('sha256', key)
      .update(`${tenantId}\u0000${conversationId}\u0000${type}\u0000${normalised}`)
      .digest('hex')
      .slice(0, length);
}

const TOKEN_LENGTH = 8;

/**
 * Mapping between original values and placeholders for one request. The same value gets
 * the same placeholder across its messages, so the model can still reason about "the
 * same person / the same IBAN"; with `token` set, across the whole conversation too.
 * Without it, placeholders are numbered per request. Lives in request memory only;
 * never persisted or logged.
 */
export class PlaceholderMap {
  private readonly byValue = new Map<string, string>();
  private readonly byPlaceholder = new Map<string, string>();
  private readonly counters = new Map<EntityType, number>();

  constructor(private readonly token?: PlaceholderToken) {}

  placeholderFor(type: EntityType, value: string): string {
    const normalised = normalise(type, value);
    const key = `${type}\u0000${normalised}`;
    const existing = this.byValue.get(key);
    if (existing) return existing;
    const n = (this.counters.get(type) ?? 0) + 1;
    this.counters.set(type, n);
    const build = (id: string | number) => `${PLACEHOLDER_OPEN}${type}_${id}${PLACEHOLDER_CLOSE}`;
    let ph = build(this.token ? this.token(type, normalised, TOKEN_LENGTH) : n);
    if (this.token && this.byPlaceholder.has(ph)) {
      ph = build(this.token(type, normalised, TOKEN_LENGTH * 2));
    }
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
  if (type === 'PERSON') return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr');
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Removes spans touching a placeholder already in the text. Tool results and earlier
 * tool-call arguments come back holding placeholders, and name detection may take one
 * for a name; masking it again would make it unrecoverable.
 */
export function withoutPlaceholders(text: string, spans: Span[]): Span[] {
  const existing = [...text.matchAll(PLACEHOLDER_RE)].map((m) => ({
    start: m.index,
    end: m.index + m[0].length,
  }));
  if (existing.length === 0) return spans;
  return spans.filter((s) => !existing.some((p) => s.start < p.end && p.start < s.end));
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
