// SPDX-License-Identifier: AGPL-3.0-only
// Tells a company's admins when its monthly tokens reach 50, 80 and 100% (LLD-03 §6, tracker
// P1-41). Once per threshold per month, because budget_alerts holds a unique row for each.
import type { Logger } from '@katip/shared';
import { createTransport } from 'nodemailer';
import { currentMonth } from './company.js';
import type { ConsoleStore } from './stores.js';

export const THRESHOLDS = [50, 80, 100] as const;
const CLASSES = ['standard', 'premium'] as const;

export interface Mail {
  to: string[];
  subject: string;
  text: string;
}
export type Mailer = (mail: Mail) => Promise<void>;

export function smtpMailer(host: string, port: number, from: string): Mailer {
  const transport = createTransport({ host, port, secure: false });
  return async (mail) => {
    await transport.sendMail({ from, bcc: mail.to, subject: mail.subject, text: mail.text });
  };
}

/** Turkish first, then English, as the console has no per-person language on the server. */
export function alertMail(company: string, cls: string, threshold: number) {
  const tr = cls === 'premium' ? 'premium' : 'standart';
  const reached = threshold >= 100;
  return {
    subject: reached
      ? `${company}: aylık ${tr} jeton kotası doldu`
      : `${company}: aylık ${tr} jeton kotasının %${threshold} kadarı kullanıldı`,
    text: [
      reached
        ? `${company} şirketinin bu ayki ${tr} jeton kotası doldu. Kota dolunca ne olacağını konsoldaki Modeller ve politikalar ekranından seçebilirsiniz.`
        : `${company} şirketi bu ayki ${tr} jeton kotasının %${threshold} kadarını kullandı. Ayrıntılar konsoldaki Genel bakış ekranındadır.`,
      '',
      reached
        ? `${company} has used all of this month's ${cls} tokens. You choose what happens then on the console's Models and policies screen.`
        : `${company} has used ${threshold}% of this month's ${cls} tokens. See the console's Overview screen for details.`,
    ].join('\n'),
  };
}

/** The highest threshold reached that hasn't been told yet, and those below it, quietly. */
export async function checkAlerts(
  store: ConsoleStore,
  mailer: Mailer,
  log: Logger,
  now: Date = new Date(),
): Promise<number> {
  const month = currentMonth(now);
  let sent = 0;
  for (const tenant of await store.listTenants()) {
    if (tenant.status !== 'active') continue;
    const { limits, used } = await store.overview(tenant.id, month);
    if (!limits) continue;
    for (const cls of CLASSES) {
      const limit = limits[cls];
      if (limit <= 0) continue;
      const percent = (used[cls] / limit) * 100;
      const reached = THRESHOLDS.filter((t) => percent >= t);
      const highest = reached.at(-1);
      if (highest === undefined) continue;
      try {
        // Inside the transaction: if the email fails, the row goes too, and the next check retries.
        const told = await store.recordAlerts(
          tenant.id,
          month,
          cls,
          [...reached],
          async (admins) => {
            if (admins.length === 0) return;
            await mailer({ to: admins, ...alertMail(tenant.name, cls, highest) });
          },
        );
        if (told) sent += 1;
      } catch (e) {
        log.warn(
          { err: { name: (e as Error).name }, tenant: tenant.slug, threshold: highest },
          'could not send a usage alert',
        );
      }
    }
  }
  return sent;
}
