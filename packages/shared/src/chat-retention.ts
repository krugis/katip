// SPDX-License-Identifier: AGPL-3.0-only
// When a company's chats may start to go (tracker P1-70, LLD-07 §2c). Pure, with the clock passed
// in. The one rule all of this keeps: nothing is deleted under a period sooner than 30 days after
// everyone was told about that period, or a shorter one.

export const CHAT_NOTICE_DAYS = 30;

/** An unsent notice older than this means nothing is sending it. The check runs every minute. */
const NOTICE_LATE_MS = 3_600_000;

export interface RetentionNotice {
  id: string;
  /** The period people are told about. It never changes: a notice has one text for everyone. */
  months: number;
  requestedAt: Date;
  /** When the last person on the list was told. The 30 days run from here. */
  notifiedAt: Date | null;
}

export interface RetentionState {
  /** What the company has chosen. */
  months: number;
  /** What is deleted under today. Null until the company's first notice has run its 30 days. */
  inForce: number | null;
  notice: RetentionNotice | null;
}

export interface RetentionRow {
  inForceMonths: number | null;
  noticeId: string | null;
  noticeMonths: number | null;
  noticeRequestedAt: Date | null;
  notifiedAt: Date | null;
}

export const retentionStateOf = (
  months: number,
  row: RetentionRow | undefined,
): RetentionState => ({
  months,
  inForce: row?.inForceMonths ?? null,
  notice:
    row?.noticeId && row.noticeMonths !== null && row.noticeRequestedAt
      ? {
          id: row.noticeId,
          months: row.noticeMonths,
          requestedAt: row.noticeRequestedAt,
          notifiedAt: row.notifiedAt,
        }
      : null,
});

export const retentionRowOf = ({ inForce, notice }: RetentionState): RetentionRow => ({
  inForceMonths: inForce,
  noticeId: notice?.id ?? null,
  noticeMonths: notice?.months ?? null,
  noticeRequestedAt: notice?.requestedAt ?? null,
  notifiedAt: notice?.notifiedAt ?? null,
});

/** The earliest a deletion can come, for a notice that went out at `from`. */
export const noticeEndsAt = (from: Date): Date =>
  new Date(from.getTime() + CHAT_NOTICE_DAYS * 86_400_000);

export const deletionStartsAt = (notice: RetentionNotice | null): Date | null =>
  notice?.notifiedAt ? noticeEndsAt(notice.notifiedAt) : null;

/**
 * Where a company stands at `now`. Only a notice's time running out moves it on. The two checks
 * before that are for a period changed by any way other than changeRetention, such as by hand in
 * the database: it can make a deletion later, but never sooner.
 */
export function advanceRetention(state: RetentionState, now: Date): RetentionState {
  const { months, inForce, notice } = state;
  if (inForce !== null && months >= inForce) return { months, inForce: months, notice: null };
  if (notice && months < notice.months) return { months, inForce, notice: null };
  const startsAt = deletionStartsAt(notice);
  if (startsAt && now >= startsAt) return { months, inForce: months, notice: null };
  return state;
}

/** The daily job's step: what time has done, and a notice if people need telling and aren't. */
export function retentionDay(
  state: RetentionState,
  now: Date,
  newId: () => string,
): RetentionState {
  const current = advanceRetention(state, now);
  const waiting = current.inForce === null || current.months < current.inForce;
  if (current.notice || !waiting) return current;
  return {
    ...current,
    notice: { id: newId(), months: current.months, requestedAt: now, notifiedAt: null },
  };
}

/** An admin chooses a period. */
export function changeRetention(
  state: RetentionState,
  months: number,
  now: Date,
  newId: () => string,
): RetentionState {
  const current = advanceRetention(state, now);
  const { inForce, notice } = current;
  // No shorter than what's in force: at once, and nothing is waiting any more.
  if (inForce !== null && months >= inForce) return { months, inForce: months, notice: null };
  // Nothing has been enforced or announced yet, so the first run will tell people this period.
  if (inForce === null && !notice) return { ...current, months };
  // They've been told about this period or a shorter one by that date, so the date stands.
  if (notice?.notifiedAt && months >= notice.months) return { ...current, months };
  // Still going out, and saying the right thing.
  if (notice && !notice.notifiedAt && months === notice.months) return current;
  // Anything else tells people something new, so it's a new notice, to everyone, and a new wait.
  return {
    months,
    inForce,
    notice: { id: newId(), months, requestedAt: now, notifiedAt: null },
  };
}

/** Nothing has sent this notice in the time it should have. */
export const noticeLate = ({ notice }: RetentionState, now: Date): boolean =>
  notice !== null &&
  notice.notifiedAt === null &&
  now.getTime() - notice.requestedAt.getTime() >= NOTICE_LATE_MS;
