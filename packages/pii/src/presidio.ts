// SPDX-License-Identifier: AGPL-3.0-only
import type { Span, EntityType } from './detect.js';

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
  /** Request timeout in ms. Default 10 s. */
  timeoutMs?: number;
  /** Language hint sent to the analyzer. Default 'tr'. */
  language?: string;
  /** Minimum score for a span to be kept. Default 0.8. */
  minScore?: number;
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
 */
export class PresidioClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly language: string;
  private readonly minScore: number;
  private readonly entityTypes: ReadonlySet<EntityType>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PresidioClientOptions) {
    this.url = opts.baseUrl.replace(/\/+$/, '') + '/analyze';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.language = opts.language ?? 'tr';
    this.minScore = opts.minScore ?? 0.8;
    this.entityTypes = new Set(opts.entityTypes ?? ['PERSON']);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async detect(text: string): Promise<Span[]> {
    // Skip the network call entirely for trivial inputs (cheap messages, tool outputs).
    if (text.length < 2 || !/\p{L}/u.test(text)) return [];
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
      .filter((s): s is Span => s !== null);
  }
}
