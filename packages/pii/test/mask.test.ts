// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  PlaceholderMap,
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
  });
});
