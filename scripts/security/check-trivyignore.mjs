// SPDX-License-Identifier: AGPL-3.0-only
// Checks .trivyignore.yaml, the accepted findings (P1-46, LLD-10 §6): each entry needs a reason
// and an expiry date at most MAX_DAYS ahead, so an accepted risk can't sit there for good. An
// entry past its date fails too: renew it with a fresh reason, or remove it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { ROOT, parseYaml } from '../setup/util.mjs';

export const MAX_DAYS = 180;
const SECTIONS = ['vulnerabilities', 'misconfigurations', 'secrets', 'licenses'];
const DAY = 24 * 60 * 60 * 1000;

/** Every problem with the allowlist's text, as of `today` (a Date). */
export function allowlistProblems(text, today = new Date()) {
  const problems = [];
  const doc = parseYaml(text) ?? {};
  for (const key of Object.keys(doc)) {
    if (!SECTIONS.includes(key)) problems.push(`${key}: not a section Trivy reads`);
  }
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  for (const section of SECTIONS) {
    const entries = doc[section] ?? [];
    if (!Array.isArray(entries)) {
      problems.push(`${section}: must be a list`);
      continue;
    }
    entries.forEach((e, i) => {
      const where = `${section}[${i}]${e?.id ? ` ${e.id}` : ''}`;
      if (!e?.id) problems.push(`${where}: no id`);
      if (!e?.statement || String(e.statement).trim().length < 10) {
        problems.push(`${where}: no statement saying why it is accepted`);
      }
      const at = String(e?.expired_at ?? '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(at) || Number.isNaN(Date.parse(`${at}T00:00:00Z`))) {
        problems.push(`${where}: expired_at must be a date, YYYY-MM-DD`);
        return;
      }
      const expires = Date.parse(`${at}T00:00:00Z`);
      if (expires <= start) problems.push(`${where}: expired on ${at}; renew it or remove it`);
      if (expires - start > MAX_DAYS * DAY) {
        problems.push(`${where}: expires more than ${MAX_DAYS} days ahead`);
      }
    });
  }
  return problems;
}

if (process.argv[1]?.endsWith('check-trivyignore.mjs')) {
  const file = join(ROOT, '.trivyignore.yaml');
  const problems = existsSync(file) ? allowlistProblems(readFileSync(file, 'utf8')) : [];
  if (problems.length > 0) {
    console.error(`.trivyignore.yaml:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('.trivyignore.yaml OK');
}
