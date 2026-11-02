// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isCliEntry } from '../src/cli-entry.js';

describe('isCliEntry', () => {
  it('matches the script itself, built or from source', () => {
    expect(isCliEntry('/repo/packages/db/src/seed.ts', 'seed')).toBe(true);
    expect(isCliEntry('/app/node_modules/@katip/db/dist/seed.js', 'seed')).toBe(true);
    expect(isCliEntry('/repo/packages/db/src/migrate.ts', 'migrate')).toBe(true);
  });

  it('does not match a script that only ends with the name', () => {
    // Regression: the bootstrap's db-seed.mjs started the seed on import,
    // before the migration had created any tables.
    expect(isCliEntry('/app/policy-gateway/db-seed.mjs', 'seed')).toBe(false);
    expect(isCliEntry('/app/db-migrate.mjs', 'migrate')).toBe(false);
  });

  it('does not match other scripts or a missing argv entry', () => {
    expect(isCliEntry('/app/server.js', 'seed')).toBe(false);
    expect(isCliEntry('/repo/seed.json', 'seed')).toBe(false);
    expect(isCliEntry(undefined, 'seed')).toBe(false);
  });
});
