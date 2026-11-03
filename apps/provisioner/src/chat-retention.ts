// SPDX-License-Identifier: AGPL-3.0-only
// Deletes a company's old chats (tracker P1-70, LLD-07 §2c). The period comes from its row
// here, never from the caller, so the host can't ask for anything younger to go. The search
// index and files are done by the host between the two steps, as Mongo says what they are.
import type { DeletedChats, ExpiredChats } from './librechat-data.js';
import type { ProvisionerStore } from './store.js';

export interface ChatRetentionDeps {
  store: Pick<ProvisionerStore, 'chatRetentionPeriods' | 'auditAction'>;
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
  return { ...period, cutoff: retentionCutoff(now, period.months) };
};

export const chatRetentionDue = async (deps: ChatRetentionDeps): Promise<string[]> =>
  (await deps.store.chatRetentionPeriods()).map((p) => p.slug);

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
