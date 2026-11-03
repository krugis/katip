// SPDX-License-Identifier: AGPL-3.0-only
// How much personal data the structured detectors really find in Turkish text (tracker P1-13,
// LLD-03 §5). This is a floor, in CI. Names need the model: `pnpm test:pii-names` checks those.
import { describe, expect, it } from 'vitest';
import { detectStructured, type EntityType } from '../src/index.js';
import fixtures from './fixtures/tr-recall.json' with { type: 'json' };

const STRUCTURED: EntityType[] = [
  'TR_TCKN',
  'TR_VKN',
  'TR_IBAN',
  'TR_PHONE',
  'EMAIL_ADDRESS',
  'CREDIT_CARD',
];
const FLOOR = 0.95;

interface Case {
  text: string;
  entities: { type: string; value: string }[];
}
const cases = fixtures.cases as Case[];

/** Found if a detected span of that type covers the marked value. */
function recallFor(type: EntityType): { found: number; total: number; missed: string[] } {
  let found = 0;
  let total = 0;
  const missed: string[] = [];
  for (const c of cases) {
    const spans = detectStructured(c.text);
    for (const entity of c.entities.filter((e) => e.type === type)) {
      total += 1;
      const start = c.text.indexOf(entity.value);
      const end = start + entity.value.length;
      if (spans.some((s) => s.type === type && s.start <= start && s.end >= end)) found += 1;
      else missed.push(c.text);
    }
  }
  return { found, total, missed };
}

describe('the Turkish fixtures', () => {
  it('hold at least 200 sentences', () => {
    expect(cases.length).toBeGreaterThanOrEqual(200);
  });
});

describe('recall of structured personal data', () => {
  it.each(STRUCTURED)(`%s is found at least ${FLOOR * 100}% of the time`, (type) => {
    const { found, total, missed } = recallFor(type);
    expect(total).toBeGreaterThan(0);
    expect(found / total, `missed: ${missed.slice(0, 5).join(' | ')}`).toBeGreaterThanOrEqual(
      FLOOR,
    );
  });
});

describe('sentences with nothing personal', () => {
  it.each(fixtures.clean)('finds nothing in: %s', (text) => {
    expect(detectStructured(text)).toEqual([]);
  });
});
