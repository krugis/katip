// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  PlaceholderMap,
  conversationTokens,
  type PlaceholderToken,
  StreamingUnmasker,
  detectStructured,
  maskMessages,
  maskText,
  unmaskText,
  vknCheckDigit,
} from '../src/index.js';

const VKN = '123456789' + vknCheckDigit('123456789');

describe('detectStructured (Turkish examples)', () => {
  const cases: Array<[string, string[]]> = [
    ['TC kimlik numaram 10000000146, teşekkürler.', ['TR_TCKN']],
    ['IBAN: TR33 0006 1005 1978 6457 8413 26 hesabına gönderin', ['TR_IBAN']],
    ['Beni 0532 123 45 67 numarasından arayın', ['TR_PHONE']],
    ['Cep: +90 532 123 45 67', ['TR_PHONE']],
    ['E-posta: ayse.yilmaz@ornek.com.tr', ['EMAIL_ADDRESS']],
    [`Firma VKN ${VKN} olarak fatura kesilsin`, ['TR_VKN']],
    ['Kart 4111 1111 1111 1111 ile ödeme', ['CREDIT_CARD']],
    ['Sipariş no 12345678901 hazır', []],
    ['Toplam 1.250,00 TL, fatura no 2026-0042', []],
  ];
  it.each(cases)('%s', (text, expected) => {
    expect(detectStructured(text).map((s) => s.type)).toEqual(expected);
  });

  it('does not treat a random 10-digit number as VKN without context', () => {
    expect(detectStructured(`Referans ${VKN}`).map((s) => s.type)).toEqual([]);
  });
});

describe('masking and un-masking', () => {
  it('uses stable placeholders for repeated values', () => {
    const map = new PlaceholderMap();
    const text = 'TCKN 10000000146 ve yine 10000000146; IBAN TR330006100519786457841326';
    const masked = maskText(text, detectStructured(text), map);
    expect(masked).toBe('TCKN ⟦TR_TCKN_1⟧ ve yine ⟦TR_TCKN_1⟧; IBAN ⟦TR_IBAN_1⟧');
    expect(unmaskText(masked, map)).toBe(text);
    expect(map.counts()).toEqual({ TR_TCKN: 1, TR_IBAN: 1 });
  });

  it('restores placeholders split across stream chunks', () => {
    const map = new PlaceholderMap();
    const masked = maskText(
      'IBAN TR330006100519786457841326',
      detectStructured('IBAN TR330006100519786457841326'),
      map,
    );
    expect(masked).toBe('IBAN ⟦TR_IBAN_1⟧');
    const u = new StreamingUnmasker(map);
    const chunks = ['Hesap: ⟦TR', '_IBAN', '_1⟧ olarak', ' kaydedildi.'];
    const out = chunks.map((c) => u.push(c)).join('') + u.flush();
    expect(out).toBe('Hesap: TR330006100519786457841326 olarak kaydedildi.');
  });

  it('does not hold back text forever on a stray opening bracket', () => {
    const u = new StreamingUnmasker(new PlaceholderMap());
    const first = u.push('⟦' + 'x'.repeat(60));
    expect(first.length).toBe(61);
  });
});

describe('maskMessages with policy', () => {
  const messages = [
    { role: 'system', content: 'Sen bir asistansın.' },
    { role: 'user', content: 'Müşteri TCKN 10000000146, tel 0532 123 45 67' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'IBAN TR33 0006 1005 1978 6457 8413 26' },
        { type: 'image_url', image_url: { url: 'x' } },
      ],
    },
  ];

  it('masks in mask mode', async () => {
    const map = new PlaceholderMap();
    const r = await maskMessages(messages, { mode: 'mask' }, map);
    expect(r.blocked).toEqual([]);
    expect(r.messages[1]!.content).toBe('Müşteri TCKN ⟦TR_TCKN_1⟧, tel ⟦TR_PHONE_1⟧');
    const parts = r.messages[2]!.content as Array<{ type: string; text?: string }>;
    expect(parts[0]!.text).toBe('IBAN ⟦TR_IBAN_1⟧');
    expect(parts[1]!.type).toBe('image_url');
  });

  it('reports blocked entity types in block mode', async () => {
    const r = await maskMessages(
      messages,
      { mode: 'mask', entities: { TR_TCKN: 'block' } },
      new PlaceholderMap(),
    );
    expect(r.blocked).toEqual(['TR_TCKN']);
  });

  it('leaves text untouched when off', async () => {
    const r = await maskMessages(messages, { mode: 'off' }, new PlaceholderMap());
    expect(r.messages).toBe(messages);
  });

  it('merges spans from an extra detector (e.g. Presidio PERSON)', async () => {
    const extra = async (text: string) => {
      const i = text.indexOf('Ayşe Yılmaz');
      return i === -1
        ? []
        : [{ type: 'PERSON' as const, start: i, end: i + 11, value: 'Ayşe Yılmaz', score: 0.85 }];
    };
    const r = await maskMessages(
      [{ role: 'user', content: 'Ayşe Yılmaz izin istedi' }],
      { mode: 'mask' },
      new PlaceholderMap(),
      extra,
    );
    expect(r.messages[0]!.content).toBe('⟦PERSON_1⟧ izin istedi');
    expect(r.detectorFailed).toBe(false);
  });

  it('reports a failed detector, still masks structured data, and stops calling it', async () => {
    let calls = 0;
    const extra = async () => {
      calls += 1;
      throw new Error('analyzer down');
    };
    const r = await maskMessages(
      [
        { role: 'user', content: 'Ayşe Yılmaz TCKN 10000000146' },
        { role: 'user', content: 'Mehmet Kaya yarın gelecek' },
      ],
      { mode: 'mask' },
      new PlaceholderMap(),
      extra,
    );
    expect(r.detectorFailed).toBe(true);
    expect(calls).toBe(1);
    expect(r.messages[0]!.content).toBe('Ayşe Yılmaz TCKN ⟦TR_TCKN_1⟧');
  });

  it('does not call the detector when PERSON masking is off', async () => {
    let calls = 0;
    const extra = async () => {
      calls += 1;
      throw new Error('analyzer down');
    };
    const r = await maskMessages(
      [{ role: 'user', content: 'Ayşe Yılmaz izin istedi' }],
      { mode: 'mask', entities: { PERSON: 'off' } },
      new PlaceholderMap(),
      extra,
    );
    expect(calls).toBe(0);
    expect(r.detectorFailed).toBe(false);
  });
});

describe('conversation placeholders', () => {
  const tokens = (conversation = 'c-1', tenant = 't-1', key = 'k'.repeat(32)) =>
    conversationTokens(key, tenant, conversation);
  const name = 'Ayşe Yılmaz';

  it('gives a value the same placeholder on every request, whatever the order', () => {
    const first = new PlaceholderMap(tokens());
    const ph = first.placeholderFor('PERSON', name);
    first.placeholderFor('PERSON', 'Mehmet Kaya');

    const second = new PlaceholderMap(tokens());
    second.placeholderFor('PERSON', 'Mehmet Kaya');
    expect(second.placeholderFor('PERSON', name)).toBe(ph);
    expect(ph).toMatch(/^⟦PERSON_[0-9a-f]{8}⟧$/);
  });

  it('treats spacing and Turkish casing as the same person', () => {
    const map = new PlaceholderMap(tokens());
    const ph = map.placeholderFor('PERSON', 'Işık Yılmaz');
    expect(map.placeholderFor('PERSON', 'ışık  yılmaz')).toBe(ph);
    expect(map.original(ph)).toBe('Işık Yılmaz');
  });

  it.each([
    ['conversation', tokens('c-2')],
    ['tenant', tokens('c-1', 't-2')],
    ['key', tokens('c-1', 't-1', 'x'.repeat(32))],
  ])('differs per %s, so tokens cannot be linked', (_label, other) => {
    const a = new PlaceholderMap(tokens()).placeholderFor('TR_TCKN', '10000000146');
    const b = new PlaceholderMap(other).placeholderFor('TR_TCKN', '10000000146');
    expect(a).not.toBe(b);
  });

  it('does not put the value in the token', () => {
    const ph = new PlaceholderMap(tokens()).placeholderFor('TR_TCKN', '10000000146');
    expect(ph).not.toContain('10000000146');
  });

  it('uses a longer token if one is already taken', () => {
    const fixed: PlaceholderToken = (type, value, length) =>
      length > 8 ? value.padEnd(length, '0').replace(/[^0-9a-f]/g, 'a') : 'abcd1234';
    const map = new PlaceholderMap(fixed);
    const a = map.placeholderFor('PERSON', 'Ayşe');
    const b = map.placeholderFor('PERSON', 'Mehmet');
    expect(a).not.toBe(b);
    expect(map.original(a)).toBe('Ayşe');
    expect(map.original(b)).toBe('Mehmet');
  });

  it('numbers placeholders per request when there is no conversation', () => {
    expect(new PlaceholderMap().placeholderFor('PERSON', name)).toBe('⟦PERSON_1⟧');
  });

  it('restores hash placeholders in text and across stream chunks', () => {
    const map = new PlaceholderMap(tokens());
    const ph = map.placeholderFor('PERSON', name);
    expect(unmaskText(`Merhaba ${ph}!`, map)).toBe(`Merhaba ${name}!`);
    const u = new StreamingUnmasker(map);
    const cut = 5;
    const out = u.push(`Merhaba ${ph.slice(0, cut)}`) + u.push(`${ph.slice(cut)}!`) + u.flush();
    expect(out).toBe(`Merhaba ${name}!`);
  });

  it('leaves a placeholder alone when its value is not in this request', () => {
    const other = new PlaceholderMap(tokens());
    const ph = other.placeholderFor('PERSON', name);
    expect(unmaskText(`Merhaba ${ph}`, new PlaceholderMap(tokens()))).toBe(`Merhaba ${ph}`);
  });

  it('does not mask a placeholder again when name detection flags it', async () => {
    const map = new PlaceholderMap(tokens());
    const ph = map.placeholderFor('PERSON', name);
    const text = `Sonuç: ${ph} ve Mehmet Kaya`;
    const flagsEverything = async (t: string) => {
      const i = t.indexOf('PERSON_');
      const j = t.indexOf('Mehmet Kaya');
      return [
        { type: 'PERSON' as const, start: i, end: i + 15, value: t.slice(i, i + 15), score: 0.9 },
        { type: 'PERSON' as const, start: j, end: j + 11, value: 'Mehmet Kaya', score: 0.9 },
      ];
    };
    const r = await maskMessages(
      [{ role: 'tool', content: text }],
      { mode: 'mask' },
      map,
      flagsEverything,
    );
    const out = r.messages[0]!.content as string;
    expect(out).toContain(ph);
    expect(out).not.toContain('Mehmet');
    expect(out.match(/⟦/g)).toHaveLength(2);
  });
});
