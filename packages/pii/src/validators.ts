// SPDX-License-Identifier: AGPL-3.0-only
// Checksum validators for Turkish identifiers. Pure functions, no I/O.

const digitsOf = (s: string): number[] => s.replace(/\D/g, '').split('').map(Number);
const mod10 = (n: number): number => ((n % 10) + 10) % 10;

/** T.C. Kimlik No: 11 digits, first digit not 0, two check digits. */
export function isValidTckn(value: string): boolean {
  const raw = value.replace(/\s/g, '');
  if (!/^[1-9]\d{10}$/.test(raw)) return false;
  const d = digitsOf(raw);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  const d10 = mod10(odd * 7 - even);
  if (d10 !== d[9]) return false;
  const sum10 = d.slice(0, 10).reduce((a, b) => a + b, 0);
  return mod10(sum10) === d[10];
}

/** Vergi Kimlik No (tax number): 10 digits with a check digit. */
export function vknCheckDigit(first9: string): number {
  const d = digitsOf(first9);
  if (d.length !== 9) throw new Error('VKN check digit needs 9 digits');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 10 - (i + 1)) % 10;
    sum += tmp === 9 ? 9 : (tmp * 2 ** (10 - (i + 1))) % 9;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidVkn(value: string): boolean {
  const raw = value.replace(/\s/g, '');
  if (!/^\d{10}$/.test(raw)) return false;
  return vknCheckDigit(raw.slice(0, 9)) === Number(raw[9]);
}

/** IBAN validation (ISO 13616, mod-97). Accepts spaces. */
export function isValidIban(value: string): boolean {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('TR') && iban.length !== 26) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of code) remainder = (remainder * 10 + Number(c)) % 97;
  }
  return remainder === 1;
}
