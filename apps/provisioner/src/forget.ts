// SPDX-License-Identifier: AGPL-3.0-only
// Carries out one person's deletion, once their company's admin has approved it (tracker
// P1-69, LLD-07 §2b). The search index and uploaded files are done by the host first, which
// is why the LibreChat account goes last: it's how the host knows whose they are. Safe to
// repeat if it stops part-way.
import type { ProvisionerStore } from './store.js';

export interface ForgetDeps {
  store: Pick<ProvisionerStore, 'deletionsDue' | 'deletionSubject' | 'forgetUser'>;
  identity: { forgetMember(slug: string, email: string): Promise<void> };
  findLibreChatUser(database: string, email: string, keycloakId: string): Promise<string | null>;
  forgetLibreChatUser(database: string, lcUserId: string, email: string): Promise<void>;
}

const subjectOf = async (deps: ForgetDeps, slug: string, requestId: string) => {
  const subject = await deps.store.deletionSubject(slug, requestId);
  if (!subject) throw new Error(`no approved deletion ${requestId} in ${slug}`);
  return subject;
};

export const deletionsDue = (deps: ForgetDeps) => deps.store.deletionsDue();

/** Their LibreChat id, or null if they never used it. An id only: this goes in the output. */
export async function deletionLookup(
  deps: ForgetDeps,
  slug: string,
  requestId: string,
): Promise<{ lcUserId: string | null }> {
  const { email, keycloakId } = await subjectOf(deps, slug, requestId);
  return { lcUserId: await deps.findLibreChatUser(`lc_${slug}`, email, keycloakId) };
}

export async function finishDeletion(
  deps: ForgetDeps,
  slug: string,
  requestId: string,
): Promise<void> {
  const subject = await subjectOf(deps, slug, requestId);
  const database = `lc_${slug}`;
  const lcUserId = await deps.findLibreChatUser(database, subject.email, subject.keycloakId);
  if (lcUserId) await deps.forgetLibreChatUser(database, lcUserId, subject.email);
  await deps.identity.forgetMember(slug, subject.email);
  // Last, because the email above comes from this row.
  await deps.store.forgetUser(subject.tenantId, subject.userId, requestId, slug);
}
