// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isValidIban, isValidTckn, isValidVkn, vknCheckDigit } from '../src/index.js';

describe('TCKN', () => {
  it('accepts valid numbers', () => {
    expect(isValidTckn('10000000146')).toBe(true);
  });
  it('rejects wrong check digits, leading zero and wrong length', () => {
    expect(isValidTckn('10000000147')).toBe(false);
    expect(isValidTckn('10000000156')).toBe(false);
    expect(isValidTckn('00000000146')).toBe(false);
    expect(isValidTckn('1000000014')).toBe(false);
  });
});

describe('VKN', () => {
  it('round-trips the check digit', () => {
    const first9 = '123456789';
    const vkn = first9 + vknCheckDigit(first9);
    expect(isValidVkn(vkn)).toBe(true);
    const wrong = first9 + ((vknCheckDigit(first9) + 1) % 10);
    expect(isValidVkn(wrong)).toBe(false);
  });
});

describe('IBAN', () => {
  it('accepts a valid Turkish IBAN with and without spaces', () => {
    expect(isValidIban('TR33 0006 1005 1978 6457 8413 26')).toBe(true);
    expect(isValidIban('TR330006100519786457841326')).toBe(true);
  });
  it('rejects a changed digit and wrong length', () => {
    expect(isValidIban('TR330006100519786457841327')).toBe(false);
    expect(isValidIban('TR3300061005197864578413')).toBe(false);
  });
  it('accepts other countries', () => {
    expect(isValidIban('DE89 3704 0044 0532 0130 00')).toBe(true);
  });
});
