// SPDX-License-Identifier: AGPL-3.0-only
import { isValidIban, isValidTckn, isValidVkn } from './validators.js';

export type EntityType =
  'TR_TCKN' | 'TR_VKN' | 'TR_IBAN' | 'TR_PHONE' | 'EMAIL_ADDRESS' | 'CREDIT_CARD' | 'PERSON';

export interface Span {
  type: EntityType;
  start: number;
  end: number;
  value: string;
  score: number;
}

interface Recognizer {
  type: EntityType;
  pattern: RegExp;
  validate?: (match: string, text: string, index: number) => boolean;
  score: number;
}

/** Luhn check for card numbers. */
function luhn(value: string): boolean {
  const d = value.replace(/\D/g, '');
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const VKN_CONTEXT = /(vkn|vergi\s*(kimlik|no|numarası)|tax\s*(id|number))/i;

/**
 * Structured recognizers implemented in TypeScript (deterministic, checksum-validated).
 * PERSON detection needs an NER model and is delegated to Presidio (see presidio.ts);
 * these recognizers keep working when Presidio is unavailable.
 */
const RECOGNIZERS: Recognizer[] = [
  {
    type: 'TR_IBAN',
    pattern: /\bTR\d{2}(?:\s?[0-9]{4}){5}\s?[0-9]{2}\b/gi,
    validate: (m) => isValidIban(m),
    score: 0.99,
  },
  {
    type: 'CREDIT_CARD',
    pattern: /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
    validate: (m) => luhn(m),
    score: 0.9,
  },
  {
    type: 'TR_TCKN',
    pattern: /(?<!\d)[1-9]\d{10}(?!\d)/g,
    validate: (m) => isValidTckn(m),
    score: 0.95,
  },
  {
    type: 'TR_VKN',
    pattern: /(?<!\d)\d{10}(?!\d)/g,
    validate: (m, text, index) =>
      isValidVkn(m) && VKN_CONTEXT.test(text.slice(Math.max(0, index - 30), index)),
    score: 0.85,
  },
  {
    type: 'TR_PHONE',
    pattern: /(?<![\d+])(?:\+90[\s-]?|0)?5\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/g,
    score: 0.8,
  },
  {
    type: 'EMAIL_ADDRESS',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    score: 0.99,
  },
];

/** Detects structured PII. Overlapping spans are resolved by score, then by length. */
export function detectStructured(text: string, types?: ReadonlySet<EntityType>): Span[] {
  const found: Span[] = [];
  for (const r of RECOGNIZERS) {
    if (types && !types.has(r.type)) continue;
    r.pattern.lastIndex = 0;
    for (const m of text.matchAll(r.pattern)) {
      const value = m[0];
      const start = m.index ?? 0;
      if (r.validate && !r.validate(value, text, start)) continue;
      found.push({ type: r.type, start, end: start + value.length, value, score: r.score });
    }
  }
  return resolveOverlaps(found);
}

export function resolveOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort(
    (a, b) => b.score - a.score || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const kept: Span[] = [];
  for (const s of sorted) {
    if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
  }
  return kept.sort((a, b) => a.start - b.start);
}
