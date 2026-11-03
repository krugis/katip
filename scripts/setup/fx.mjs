// SPDX-License-Identifier: AGPL-3.0-only
// The central bank's USD rate, for invoicing in TRY (LLD-06, tracker P1-40). It runs on the
// host: the provisioner's container only stores what this passes it, and has no need to reach
// out. Published on working days, so on other days this finds the last one again.
export const TCMB_URL = 'https://www.tcmb.gov.tr/kurlar/today.xml';

/** Long enough for the longest public holidays. Older means the feed itself is stuck. */
const STALE_AFTER_DAYS = 12;

const number = (block, tag) => {
  const value = new RegExp(`<${tag}>\\s*([0-9]+\\.[0-9]+)\\s*</${tag}>`).exec(block)?.[1];
  if (!value || Number(value) <= 0) throw new Error(`the rate feed has no valid ${tag}`);
  return value;
};

/** Reads only what it needs, and refuses anything that doesn't look right. */
export function parseTcmbRate(xml, now = new Date()) {
  const header = /<Tarih_Date\b[^>]*\bTarih="(\d{2})\.(\d{2})\.(\d{4})"[^>]*>/.exec(xml);
  if (!header) throw new Error('the rate feed has no date');
  const [, day, month, year] = header;
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('the rate feed has a date that does not exist');
  }
  const ageDays = (now.getTime() - parsed.getTime()) / 86_400_000;
  if (ageDays > STALE_AFTER_DAYS) throw new Error(`the rate feed is stuck at ${date}`);
  if (ageDays < -2) throw new Error(`the rate feed is dated in the future: ${date}`);

  const block = /<Currency\b[^>]*\bKod="USD"[^>]*>([\s\S]*?)<\/Currency>/.exec(xml)?.[1];
  if (!block) throw new Error('the rate feed has no USD');
  if (/<Unit>\s*([0-9]+)\s*<\/Unit>/.exec(block)?.[1] !== '1') {
    throw new Error('the rate feed gives USD per an unexpected unit');
  }
  const buying = number(block, 'ForexBuying');
  const selling = number(block, 'ForexSelling');
  if (Number(selling) < Number(buying)) throw new Error('the rate feed sells below it buys');
  return { date, currency: 'USD', buying, selling };
}

export async function fetchTcmbRate(fetchImpl = fetch) {
  const res = await fetchImpl(TCMB_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`the rate feed answered ${res.status}`);
  return parseTcmbRate(await res.text());
}
