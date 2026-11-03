// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { fetchTcmbRate, parseTcmbRate } from '../fx.mjs';

const now = new Date('2026-11-03T16:00:00Z');
const feed = ({
  date = '03.11.2026',
  unit = '1',
  buying = '49.9094',
  selling = '49.9993',
  code = 'USD',
} = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<Tarih_Date Tarih="${date}" Date="11/03/2026" Bulten_No="2026/206">
  <Currency CrossOrder="1" Kod="AUD" CurrencyCode="AUD">
    <Unit>1</Unit><ForexBuying>1.1111</ForexBuying><ForexSelling>2.2222</ForexSelling>
  </Currency>
  <Currency CrossOrder="0" Kod="${code}" CurrencyCode="${code}">
    <Unit>${unit}</Unit>
    <ForexBuying>${buying}</ForexBuying>
    <ForexSelling>${selling}</ForexSelling>
    <BanknoteSelling>99.0000</BanknoteSelling>
  </Currency>
</Tarih_Date>`;

describe('reading the central bank feed', () => {
  it('takes USD, not the first currency, and forex rather than banknote', () => {
    expect(parseTcmbRate(feed(), now)).toEqual({
      date: '2026-11-03',
      currency: 'USD',
      buying: '49.9094',
      selling: '49.9993',
    });
  });

  it('keeps the rate as written, so nothing is lost to rounding', () => {
    expect(parseTcmbRate(feed({ selling: '50.1000' }), now).selling).toBe('50.1000');
  });

  it('accepts a holiday’s older date, and not a stuck feed', () => {
    expect(parseTcmbRate(feed({ date: '26.10.2026' }), now).date).toBe('2026-10-26');
    expect(() => parseTcmbRate(feed({ date: '01.10.2026' }), now)).toThrow(/stuck/);
  });

  it.each([
    ['no USD', () => feed({ code: 'EUR' }), /no USD/],
    ['a date in the future', () => feed({ date: '20.11.2026' }), /future/],
    ['a date that does not exist', () => feed({ date: '31.02.2026' }), /does not exist/],
    ['no date', () => feed().replace(/Tarih="[^"]*"/, ''), /no date/],
    ['an unexpected unit', () => feed({ unit: '100' }), /unit/],
    ['an empty rate', () => feed({ selling: '' }), /ForexSelling/],
    ['a zero rate', () => feed({ buying: '0.0000' }), /ForexBuying/],
    ['text for a rate', () => feed({ selling: '<b>x</b>' }), /ForexSelling/],
    ['selling below buying', () => feed({ selling: '10.0000' }), /sells below/],
  ])('refuses %s', (_name, make, message) => {
    expect(() => parseTcmbRate(make(), now)).toThrow(message);
  });

  it('refuses something that is not the feed at all', () => {
    expect(() => parseTcmbRate('<html>Bakım çalışması</html>', now)).toThrow(/no date/);
  });

  it('says so when the feed is down', async () => {
    const down = async () => new Response('no', { status: 503 });
    await expect(fetchTcmbRate(down)).rejects.toThrow(/503/);
  });
});
