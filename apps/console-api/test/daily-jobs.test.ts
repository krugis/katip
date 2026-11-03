// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { dailyJobState } from '../src/audit.js';

const now = new Date('2026-11-03T12:00:00Z');
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000);

describe('how the daily job is doing', () => {
  it('has never run', () => {
    expect(dailyJobState(null, now)).toEqual({ state: 'never', lastRun: null, failed: 0 });
  });

  it('ran recently and well', () => {
    const last = { ts: hoursAgo(3), details: { deleted: 1, failed: 0 } };
    expect(dailyJobState(last, now).state).toBe('ok');
  });

  it('has stopped running: a day and a bit, so a slow run is not an alarm', () => {
    const fine = { ts: hoursAgo(25), details: { failed: 0 } };
    expect(dailyJobState(fine, now).state).toBe('ok');
    const late = { ts: hoursAgo(27), details: { failed: 0 } };
    expect(dailyJobState(late, now).state).toBe('late');
  });

  it('ran, but something in it failed', () => {
    const last = { ts: hoursAgo(3), details: { failed: 2 } };
    expect(dailyJobState(last, now)).toMatchObject({ state: 'failed', failed: 2 });
  });

  it('counts being late as worse than an old failure', () => {
    const last = { ts: hoursAgo(40), details: { failed: 2 } };
    expect(dailyJobState(last, now).state).toBe('late');
  });
});
