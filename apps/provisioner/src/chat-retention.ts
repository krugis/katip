// SPDX-License-Identifier: AGPL-3.0-only
// Deletes a company's old chats (tracker P1-70, LLD-07 §2c). The period comes from its row
// here, never from the caller, so the host can't ask for anything younger to go, and nothing goes
// until people have been told and 30 days have passed. console-api sends the emails, as this has
// no mail server, so this only asks for them and reads whether they went. The search index and
// files are done by the host between the two steps, as Mongo says what they are.
import { randomUUID } from 'node:crypto';
import { advanceRetention, noticeLate, retentionDay } from '@katip/shared';
import type { DeletedChats, ExpiredChats } from './librechat-data.js';
import type { ProvisionerStore } from './store.js';

export interface ChatRetentionDeps {
  store: Pick<ProvisionerStore, 'chatRetentionPeriods' | 'stepChatRetention' | 'auditAction'>;
  findExpiredChats(database: string, cutoff: Date): Promise<ExpiredChats>;
  deleteExpiredChats(
    database: string,
    conversationIds: string[],
    fileIds: string[],
    cutoff: Date,
  ): Promise<DeletedChats>;
  now?: () => Date;
}

/** `months` calendar months back in UTC. The 31st of a shorter month is that month's last day. */
export function retentionCutoff(now: Date, months: number): Date {
  // A bad value here deletes the wrong chats, whatever the column's check says.
  if (!Number.isInteger(months) || months < 1) throw new Error('invalid retention period');
  const cutoff = new Date(now);
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0),
  ).getUTCDate();
  cutoff.setUTCDate(Math.min(now.getUTCDate(), lastDay));
  return cutoff;
}

const periodOf = async (deps: ChatRetentionDeps, slug: string) => {
  const [period] = await deps.store.chatRetentionPeriods(slug);
  if (!period) throw new Error(`${slug} is not a running company`);
  const now = deps.now?.() ?? new Date();
  const months = advanceRetention(period.state, now).inForce;
  if (months === null) throw new Error(`${slug} has not had its notice period yet`);
  return { tenantId: period.tenantId, months, cutoff: retentionCutoff(now, months) };
};

export interface ChatRetentionPlan {
  /** Whose old chats can go today, under the period in force. */
  slugs: string[];
  /** How many companies have a notice outstanding, and how many of those have been told. */
  waiting: number;
  notified: number;
  /** Whose notice should have gone out by now and hasn't. A failure, as they keep waiting. */
  unsent: string[];
}

/**
 * Each running company's day: a notice's time running out, or a first notice asked for. Safe to
 * repeat, as it does nothing the second time. Slugs go no further than the host's own output.
 */
export async function chatRetentionDue(deps: ChatRetentionDeps): Promise<ChatRetentionPlan> {
  const now = deps.now?.() ?? new Date();
  const plan: ChatRetentionPlan = { slugs: [], waiting: 0, notified: 0, unsent: [] };
  for (const { tenantId, slug } of await deps.store.chatRetentionPeriods()) {
    const { before, after } = await deps.store.stepChatRetention(tenantId, (state) =>
      retentionDay(state, now, randomUUID),
    );
    if (after.inForce !== before.inForce && after.inForce !== null) {
      await deps.store.auditAction(tenantId, 'chat_retention.started', slug, {
        months: after.inForce,
        previousMonths: before.inForce,
      });
    }
    if (after.notice && after.notice.id !== before.notice?.id) {
      await deps.store.auditAction(tenantId, 'chat_retention.notice_requested', slug, {
        months: after.notice.months,
      });
    }
    if (after.inForce !== null) plan.slugs.push(slug);
    if (after.notice) plan.waiting += 1;
    if (after.notice?.notifiedAt) plan.notified += 1;
    if (noticeLate(after, now)) plan.unsent.push(slug);
  }
  return plan;
}

/** Ids only: this goes in the output. */
export async function selectExpiredChats(
  deps: ChatRetentionDeps,
  slug: string,
): Promise<ExpiredChats> {
  const { cutoff } = await periodOf(deps, slug);
  return deps.findExpiredChats(`lc_${slug}`, cutoff);
}

/** Counts only in the audit entry, and none at all if nothing went. */
export async function finishExpiredChats(
  deps: ChatRetentionDeps,
  slug: string,
  batch: { conversationIds: string[]; fileIds: string[]; filesKept: number },
): Promise<DeletedChats> {
  const { tenantId, months, cutoff } = await periodOf(deps, slug);
  const deleted = await deps.deleteExpiredChats(
    `lc_${slug}`,
    batch.conversationIds,
    batch.fileIds,
    cutoff,
  );
  if (deleted.conversations > 0) {
    await deps.store.auditAction(tenantId, 'chat.retention', slug, {
      ...deleted,
      filesKept: batch.filesKept,
      months,
    });
  }
  return deleted;
}
