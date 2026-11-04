// SPDX-License-Identifier: AGPL-3.0-only
// Tells everyone in a company before its chats start to go (tracker P1-70, LLD-07 §2c). The daily
// job or an admin's change asks for a notice, and this sends it, as this is what has a mail
// server. One email per person, so a failure can be retried for that person alone.
import { noticeEndsAt, type Logger } from '@katip/shared';
import type { Mailer } from './alerts.js';
import type { ConsoleStore } from './stores.js';

const dateIn = (locale: string, date: Date) =>
  new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Istanbul' }).format(date);

/** Turkish first, then English, like the usage alerts. It names no chat. */
export function chatNoticeMail(company: string, months: number, startsAt: Date) {
  const tr = dateIn('tr-TR', startsAt);
  const en = dateIn('en-GB', startsAt);
  return {
    subject: `${company}: eski sohbetler ${tr} tarihinden itibaren silinecek`,
    text: [
      `${company} şirketinde ${months} aydan uzun süredir kullanılmayan sohbetler, en erken ${tr} tarihinden itibaren kalıcı olarak silinecek.`,
      'Bu sohbetlerin mesajları, paylaşım bağlantıları ve yalnızca bu sohbetlere eklenmiş dosyaları da silinir. Silinenler geri getirilemez.',
      `Saklama süresi: ${months} ay. Sorularınız için şirketinizin Kâtip yöneticisine başvurun.`,
      '',
      `At ${company}, chats with no activity for more than ${months} months will be permanently deleted from ${en} at the earliest.`,
      'Their messages, shared links and the files attached only to them go too. What is deleted cannot be brought back.',
      `Retention period: ${months} months. If you have questions, ask your company's Kâtip admin.`,
    ].join('\n'),
  };
}

interface MailError {
  code?: string;
  responseCode?: number;
}

/** The server refused this address for good. Anything else may work next time. */
export const addressRefused = (e: unknown): boolean => {
  const { code, responseCode } = e as MailError;
  return code === 'EENVELOPE' && responseCode !== undefined && responseCode >= 500;
};

/**
 * Sends each notice still going out, to whoever hasn't had it. The 30 days start once everyone has
 * been told, so nobody has less than that. An address the server refuses for good doesn't hold up
 * the rest, but at least one person has to have been told. Returns the notices finished.
 */
export async function sendChatNotices(
  store: ConsoleStore,
  mailer: Mailer,
  log: Logger,
  now: () => Date = () => new Date(),
): Promise<number> {
  let finished = 0;
  for (const tenant of await store.listTenants()) {
    if (tenant.status !== 'active') continue;
    try {
      const notice = await store.pendingChatNotice(tenant.id);
      if (!notice) continue;
      let told = notice.told;
      let refused = 0;
      let retry = 0;
      for (const person of notice.toTell) {
        try {
          const sent = await store.tellChatNotice(tenant.id, notice.id, person.userId, () =>
            mailer({
              to: [person.email],
              ...chatNoticeMail(tenant.name, notice.months, noticeEndsAt(now())),
            }),
          );
          if (sent) told += 1;
        } catch (e) {
          if (addressRefused(e)) {
            refused += 1;
          } else {
            retry += 1;
            // No answer at all: the server is down, so the rest would only wait to find that out.
            if ((e as MailError).responseCode === undefined) break;
          }
        }
      }
      if (retry > 0 || told === 0) {
        log.warn(
          { tenant: tenant.slug, told, refused, retry },
          'a chat retention notice has not finished going out',
        );
        continue;
      }
      // The clock read again: a long list takes time, and the last person's 30 days start now.
      if (await store.finishChatNotice(tenant.id, notice.id, now(), { told, refused })) {
        finished += 1;
      }
    } catch (e) {
      log.warn(
        { err: { name: (e as Error).name }, tenant: tenant.slug },
        'could not send a chat retention notice',
      );
    }
  }
  return finished;
}
