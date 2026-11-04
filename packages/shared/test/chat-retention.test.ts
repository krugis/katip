// SPDX-License-Identifier: AGPL-3.0-only
// The rules for when chats may start to go. Nothing may be deleted under a period sooner than
// 30 days after people were told about it, whatever sequence of changes led there.
import { describe, expect, it } from 'vitest';
import {
  advanceRetention,
  changeRetention,
  CHAT_NOTICE_DAYS,
  deletionStartsAt,
  noticeLate,
  retentionDay,
  retentionRowOf,
  retentionStateOf,
  type RetentionState,
} from '../src/chat-retention.js';

const DAY = 86_400_000;
const START = new Date('2026-11-03T12:00:00Z');
const day = (n: number) => new Date(START.getTime() + n * DAY);
let serial = 0;
const newId = () => `n${(serial += 1)}`;

const fresh = (months = 12): RetentionState => ({ months, inForce: null, notice: null });
const enforcing = (months = 12): RetentionState => ({ months, inForce: months, notice: null });
const change = (s: RetentionState, months: number, at: Date) =>
  changeRetention(s, months, at, newId);
/** console-api has told everyone. */
const sent = (s: RetentionState, at: Date): RetentionState => ({
  ...s,
  notice: { ...s.notice!, notifiedAt: at },
});
const inForceAt = (s: RetentionState, at: Date) => advanceRetention(s, at).inForce;

describe('a first run', () => {
  it('deletes nothing, and asks for a notice about the period chosen', () => {
    const s = retentionDay(fresh(6), day(0), newId);
    expect(s.inForce).toBeNull();
    expect(s.notice).toMatchObject({ months: 6, requestedAt: day(0), notifiedAt: null });
  });

  it('asks only once, however many runs it takes to send', () => {
    const first = retentionDay(fresh(), day(0), newId);
    const again = retentionDay(first, day(1), newId);
    expect(again).toEqual(first);
    expect(retentionDay(again, day(365), newId)).toEqual(first);
  });

  it('never starts while the notice has not gone, however long that takes', () => {
    const s = retentionDay(fresh(), day(0), newId);
    expect(inForceAt(s, day(1000))).toBeNull();
  });

  it('counts 30 days from the send, not from when it was asked for', () => {
    const asked = retentionDay(fresh(), day(0), newId);
    const told = sent(asked, day(10));
    expect(deletionStartsAt(told.notice)).toEqual(day(40));
    expect(inForceAt(told, day(39))).toBeNull();
    expect(inForceAt(told, new Date(day(40).getTime() - 1))).toBeNull();
    expect(inForceAt(told, day(40))).toBe(12);
  });

  it('moves on once, leaving nothing outstanding', () => {
    const told = sent(retentionDay(fresh(), day(0), newId), day(0));
    expect(retentionDay(told, day(30), newId)).toEqual({ months: 12, inForce: 12, notice: null });
    expect(retentionDay(enforcing(), day(31), newId)).toEqual(enforcing());
  });

  it('asks for nothing just because a setting changed before the first run', () => {
    const s = change(fresh(), 3, day(0));
    expect(s).toEqual({ months: 3, inForce: null, notice: null });
    expect(retentionDay(s, day(1), newId).notice?.months).toBe(3);
  });

  it('keeps its date when the period gets longer during the wait', () => {
    const told = sent(retentionDay(fresh(6), day(0), newId), day(0));
    const s = change(told, 24, day(10));
    expect(s.months).toBe(24);
    expect(s.inForce).toBeNull();
    expect(deletionStartsAt(s.notice)).toEqual(day(30));
    expect(inForceAt(s, day(30))).toBe(24);
  });

  it('starts over when the period gets shorter during the wait', () => {
    const told = sent(retentionDay(fresh(12), day(0), newId), day(0));
    const s = change(told, 6, day(20));
    expect(s.notice).toMatchObject({ months: 6, requestedAt: day(20), notifiedAt: null });
    expect(inForceAt(s, day(30))).toBeNull();
    expect(inForceAt(s, day(60))).toBeNull();
    expect(inForceAt(sent(s, day(21)), day(51))).toBe(6);
  });
});

describe('shortening', () => {
  it('leaves the old period in force, and asks for a notice', () => {
    const s = change(enforcing(12), 6, day(0));
    expect(s.months).toBe(6);
    expect(s.inForce).toBe(12);
    expect(s.notice).toMatchObject({ months: 6, requestedAt: day(0), notifiedAt: null });
  });

  it('applies the new period 30 days after the notice went, and not a moment before', () => {
    const s = sent(change(enforcing(12), 6, day(0)), day(2));
    expect(inForceAt(s, day(31))).toBe(12);
    expect(inForceAt(s, new Date(day(32).getTime() - 1))).toBe(12);
    expect(inForceAt(s, day(32))).toBe(6);
  });

  it('keeps the old period forever if the notice never goes', () => {
    const s = change(enforcing(12), 6, day(0));
    expect(inForceAt(s, day(1000))).toBe(12);
    expect(retentionDay(s, day(1000), newId).inForce).toBe(12);
  });

  it('asks for a notice only once', () => {
    const s = change(enforcing(12), 6, day(0));
    expect(retentionDay(s, day(1), newId)).toEqual(s);
  });
});

describe('lengthening', () => {
  it('takes effect at once', () => {
    expect(change(enforcing(6), 12, day(0))).toEqual(enforcing(12));
  });

  it('cancels a shortening, sent or not', () => {
    const asked = change(enforcing(12), 6, day(0));
    expect(change(asked, 12, day(1))).toEqual(enforcing(12));
    expect(change(asked, 24, day(1))).toEqual(enforcing(24));
    const told = sent(asked, day(1));
    expect(change(told, 12, day(29))).toEqual(enforcing(12));
    expect(change(told, 24, day(29))).toEqual(enforcing(24));
  });

  it('does not cancel a first notice, as the company still has to start', () => {
    const asked = retentionDay(fresh(6), day(0), newId);
    expect(change(asked, 12, day(1)).notice?.months).toBe(12);
    const told = sent(asked, day(1));
    expect(change(told, 12, day(2)).notice?.id).toBe(told.notice?.id);
  });

  it('counts from what has come into force, even if the daily job has not run since', () => {
    const told = sent(change(enforcing(12), 3, day(0)), day(0));
    // Past the date, so 3 is in force: 6 is longer, and at once.
    expect(change(told, 6, day(31))).toEqual(enforcing(6));
  });
});

describe('changing it again during a wait', () => {
  const told = () => sent(change(enforcing(12), 3, day(0)), day(0));

  it('keeps the date when it stays at or above what people were told', () => {
    const s = change(told(), 6, day(10));
    expect(s.months).toBe(6);
    expect(s.inForce).toBe(12);
    expect(deletionStartsAt(s.notice)).toEqual(day(30));
    expect(inForceAt(s, day(30))).toBe(6);
  });

  it('keeps the date going back to exactly what people were told', () => {
    const s = change(change(told(), 6, day(10)), 3, day(15));
    expect(deletionStartsAt(s.notice)).toEqual(day(30));
    expect(inForceAt(s, day(30))).toBe(3);
  });

  it('remembers what people were told, not the last thing chosen', () => {
    const s = change(change(told(), 9, day(10)), 6, day(11));
    expect(s.notice?.months).toBe(3);
    expect(deletionStartsAt(s.notice)).toEqual(day(30));
  });

  it('starts again when it goes below what people were told', () => {
    const s = change(told(), 1, day(10));
    expect(s.notice).toMatchObject({ months: 1, requestedAt: day(10), notifiedAt: null });
    expect(s.inForce).toBe(12);
    expect(inForceAt(s, day(30))).toBe(12);
    expect(inForceAt(sent(s, day(10)), day(39))).toBe(12);
    expect(inForceAt(sent(s, day(10)), day(40))).toBe(1);
  });

  it('starts again after a cancel, as people may have read the notice as over', () => {
    const cancelled = change(told(), 12, day(10));
    const s = change(cancelled, 3, day(20));
    expect(s.notice).toMatchObject({ months: 3, requestedAt: day(20), notifiedAt: null });
    expect(inForceAt(s, day(30))).toBe(12);
  });

  it('uses a new notice while the old one is still going out, so nobody has the wrong text', () => {
    const asked = change(enforcing(12), 6, day(0));
    for (const months of [3, 9]) {
      const s = change(asked, months, day(1));
      expect(s.notice?.id).not.toBe(asked.notice?.id);
      expect(s.notice).toMatchObject({ months, requestedAt: day(1), notifiedAt: null });
    }
  });

  it('does not send a notice twice for saving the same thing again', () => {
    const asked = change(enforcing(12), 6, day(0));
    expect(change(asked, 6, day(1))).toEqual(asked);
    const t = told();
    expect(change(t, 3, day(1))).toEqual(t);
    expect(change(enforcing(12), 12, day(1))).toEqual(enforcing(12));
  });

  it('stays safe through a long run of changes', () => {
    let s = enforcing(12);
    s = change(s, 6, day(0)); // notice for 6
    s = sent(s, day(1)); // would start on day 31
    s = change(s, 9, day(5)); // same date, 9
    s = change(s, 6, day(6)); // same date, 6: they were told 6
    s = change(s, 3, day(20)); // new notice, unsent
    expect(inForceAt(s, day(31))).toBe(12);
    s = change(s, 4, day(21)); // new notice for 4, as the last hadn't gone
    s = sent(s, day(22)); // starts on day 52
    expect(deletionStartsAt(s.notice)).toEqual(day(52));
    s = change(s, 12, day(40)); // cancelled
    expect(s).toEqual(enforcing(12));
    s = change(s, 4, day(41)); // starts over
    expect(inForceAt(s, day(52))).toBe(12);
    s = sent(s, day(41));
    expect(inForceAt(s, day(70))).toBe(12);
    expect(inForceAt(s, day(71))).toBe(4);
  });
});

describe('a period changed some other way, such as by hand in the database', () => {
  it('counts a longer one at once', () => {
    expect(inForceAt({ months: 24, inForce: 12, notice: null }, day(0))).toBe(24);
  });

  it('does not apply a shorter one until people have been told', () => {
    const s = { months: 3, inForce: 12, notice: null };
    expect(inForceAt(s, day(1000))).toBe(12);
    expect(retentionDay(s, day(0), newId).notice).toMatchObject({ months: 3, notifiedAt: null });
  });

  it('does not let one below a notice go through on that notice', () => {
    const told = sent(change(enforcing(12), 6, day(0)), day(0));
    const s = retentionDay({ ...told, months: 3 }, day(30), newId);
    expect(s.inForce).toBe(12);
    expect(s.notice).toMatchObject({ months: 3, requestedAt: day(30), notifiedAt: null });
  });
});

describe('any sequence at all', () => {
  /** A small seeded generator, so a failure repeats. */
  const generator = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const PERIODS = [1, 2, 3, 6, 9, 12, 24, 120];

  it('never deletes under a period people have not had 30 days of notice about', () => {
    for (let run = 0; run < 300; run += 1) {
      const random = generator(run + 1);
      let now = START;
      let s = fresh(PERIODS[Math.floor(random() * PERIODS.length)]!);
      const told: { months: number; at: Date }[] = [];
      for (let step = 0; step < 60; step += 1) {
        const roll = random();
        if (roll < 0.3) {
          s = change(s, PERIODS[Math.floor(random() * PERIODS.length)]!, now);
        } else if (roll < 0.5) {
          s = retentionDay(s, now, newId);
        } else if (roll < 0.7) {
          if (s.notice && !s.notice.notifiedAt) {
            told.push({ months: s.notice.months, at: now });
            s = sent(s, now);
          }
        } else {
          now = new Date(now.getTime() + random() * 20 * DAY);
        }
        const period = inForceAt(s, now);
        if (period !== null) {
          const fair = told.some(
            (t) => t.months <= period && t.at.getTime() + CHAT_NOTICE_DAYS * DAY <= now.getTime(),
          );
          expect(fair, `run ${run}, step ${step}: ${period} months, ${JSON.stringify(told)}`).toBe(
            true,
          );
        }
        // What's outstanding never promises less than what's been chosen.
        if (s.notice) expect(s.notice.months).toBeLessThanOrEqual(s.months);
      }
    }
  });
});

describe('a late notice', () => {
  it('is one still unsent after an hour', () => {
    const s = change(enforcing(12), 6, day(0));
    expect(noticeLate(s, new Date(day(0).getTime() + 3_599_000))).toBe(false);
    expect(noticeLate(s, new Date(day(0).getTime() + 3_600_000))).toBe(true);
    expect(noticeLate(sent(s, day(0)), day(10))).toBe(false);
    expect(noticeLate(enforcing(), day(10))).toBe(false);
  });
});

describe('the stored row', () => {
  it('comes back as what went in', () => {
    const told = sent(change(enforcing(12), 6, day(0)), day(1));
    expect(retentionStateOf(6, retentionRowOf(told))).toEqual(told);
    expect(retentionStateOf(12, retentionRowOf(enforcing()))).toEqual(enforcing());
  });

  it('is a company nothing has happened to when there is none', () => {
    expect(retentionStateOf(12, undefined)).toEqual(fresh());
  });
});
