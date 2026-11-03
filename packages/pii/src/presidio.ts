// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import type { Span, EntityType } from './detect.js';

/** The model takes about 0.4 s for this much text on 2 CPUs, well inside any one timeout. */
const CHUNK_CHARS = 2000;
const CACHE_ENTRIES = 5000;

/**
 * Cuts long text into pieces, at a line or sentence end where it can, so a name stays whole.
 * Cuts depend only on the text before them, so a conversation that grows at the end keeps
 * its earlier pieces, and those are already in the cache.
 */
export function splitForAnalysis(
  text: string,
  max = CHUNK_CHARS,
): { start: number; text: string }[] {
  const chunks: { start: number; text: string }[] = [];
  let pos = 0;
  while (text.length - pos > max) {
    const window = text.slice(pos, pos + max);
    const half = max / 2;
    let cut = window.lastIndexOf('\n') + 1;
    if (cut <= half) {
      const sentenceEnds = [...window.matchAll(/[.!?…]\s/g)];
      cut = (sentenceEnds.at(-1)?.index ?? -2) + 2;
    }
    if (cut <= half) cut = window.lastIndexOf(' ') + 1;
    if (cut <= half) {
      cut = max;
      // Never between the two halves of one character.
      const code = window.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    chunks.push({ start: pos, text: text.slice(pos, pos + cut) });
    pos += cut;
  }
  if (pos < text.length) chunks.push({ start: pos, text: text.slice(pos) });
  return chunks;
}

/** Shape of a Presidio /analyze response item (only fields we consume). */
interface PresidioResult {
  entity_type: string;
  start: number;
  end: number;
  score: number;
}

export interface PresidioClientOptions {
  /** Base URL of the analyzer service, e.g. http://presidio-analyzer:3000 */
  baseUrl: string;
  /** Timeout for each piece of the text, in ms. Default 10 s. */
  timeoutMs?: number;
  /** Language hint sent to the analyzer. Default 'tr'. */
  language?: string;
  /**
   * Minimum score for a span to be kept. Default 0.3: the model is often unsure of surnames
   * (0.48 for a real one), and a missed name costs more than a masked word.
   */
  minScore?: number;
  /** How many pieces of one text are analysed at a time. Default 2. */
  concurrency?: number;
  /** Only spans with these entity types are returned. Default ['PERSON']. */
  entityTypes?: EntityType[];
  fetchImpl?: typeof fetch;
}

/** Maps Presidio entity types to Kâtip entity types; unmapped types are dropped. */
const PRESIDIO_TO_KATIP: Record<string, EntityType> = {
  PERSON: 'PERSON',
};

/**
 * Thin client for the Presidio analyzer `/analyze` endpoint (P1-11).
 * Returns PERSON spans only; used as the `extra` detector of `maskMessages`
 * for NER-based name detection (TR + EN) that the structured recognizers can't do.
 * `detect` throws when the analyzer can't answer, so "no names found" and "could
 * not check" stay different results. Error messages never contain the text.
 * Results are remembered in memory, under a hash of the text and as positions only, because
 * every turn of a chat sends its whole history again. Nothing of the text itself is kept.
 */
export class PresidioClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly language: string;
  private readonly minScore: number;
  private readonly concurrency: number;
  private readonly cache = new Map<string, Omit<Span, 'value'>[]>();
  private readonly entityTypes: ReadonlySet<EntityType>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PresidioClientOptions) {
    this.url = opts.baseUrl.replace(/\/+$/, '') + '/analyze';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.language = opts.language ?? 'tr';
    this.minScore = opts.minScore ?? 0.3;
    this.concurrency = opts.concurrency ?? 2;
    this.entityTypes = new Set(opts.entityTypes ?? ['PERSON']);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async detect(text: string): Promise<Span[]> {
    // Skip the network call entirely for trivial inputs (cheap messages, tool outputs).
    if (text.length < 2 || !/\p{L}/u.test(text)) return [];
    const chunks = splitForAnalysis(text);
    const results: Span[][] = chunks.map(() => []);
    let next = 0;
    let failed = false;
    const worker = async (): Promise<void> => {
      while (next < chunks.length && !failed) {
        const i = next++;
        const chunk = chunks[i]!;
        try {
          results[i] = (await this.analyzeOnce(chunk.text)).map((s) => ({
            ...s,
            start: s.start + chunk.start,
            end: s.end + chunk.start,
            value: chunk.text.slice(s.start, s.end),
          }));
        } catch (err) {
          // One lost piece means names could be missed, so the whole answer is lost.
          failed = true;
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));
    return results.flat();
  }

  private async analyzeOnce(text: string): Promise<Omit<Span, 'value'>[]> {
    if (!/\p{L}/u.test(text)) return [];
    const key = createHash('sha256').update(this.language).update('\0').update(text).digest('hex');
    const known = this.cache.get(key);
    if (known) {
      // Map keeps insertion order: moving it to the end keeps the oldest entry first.
      this.cache.delete(key);
      this.cache.set(key, known);
      return known;
    }
    const spans = (await this.analyze(text)).map(({ value: _value, ...position }) => position);
    this.cache.set(key, spans);
    if (this.cache.size > CACHE_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value as string);
    }
    return spans;
  }

  private async analyze(text: string): Promise<Span[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          language: this.language,
          entities: [...this.entityTypes],
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`analyzer returned HTTP ${res.status}`);
      const data: unknown = await res.json();
      if (!Array.isArray(data)) throw new Error('analyzer returned a malformed response');
      return this.toSpans(data, text);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Validates and maps analyzer results to spans; anything malformed is dropped. */
  private toSpans(data: unknown[], text: string): Span[] {
    return data
      .filter(
        (r): r is PresidioResult =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as PresidioResult).entity_type === 'string' &&
          typeof (r as PresidioResult).start === 'number' &&
          typeof (r as PresidioResult).end === 'number' &&
          typeof (r as PresidioResult).score === 'number',
      )
      .map((r) => {
        const type = PRESIDIO_TO_KATIP[r.entity_type];
        if (!type) return null;
        if (!this.entityTypes.has(type)) return null;
        if (r.score < this.minScore) return null;
        if (r.start < 0 || r.end > text.length || r.end <= r.start) return null;
        return {
          type,
          start: r.start,
          end: r.end,
          value: text.slice(r.start, r.end),
          score: r.score,
        } satisfies Span;
      })
      .filter((s): s is Span => s !== null)
      .sort((a, b) => a.start - b.start)
      .reduce<Span[]>((merged, s) => {
        // The model can mark each word of one name apart. Masking them as one gives a name
        // one placeholder. Not across lines: maskMany joins separate strings with a newline.
        const last = merged.at(-1);
        if (last && last.type === s.type && /^[ \t]*$/.test(text.slice(last.end, s.start))) {
          merged[merged.length - 1] = {
            ...last,
            end: s.end,
            value: text.slice(last.start, s.end),
            score: Math.min(last.score, s.score),
          };
        } else merged.push(s);
        return merged;
      }, []);
  }
}
