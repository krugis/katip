// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path';

describe('where a sign-in returns to', () => {
  it.each(['/tenant/users', '/account/usage?x=1'])('keeps %s', (returnTo) => {
    expect(safeReturnPath({ returnTo })).toBe(returnTo);
  });

  it.each([
    ['another site', 'https://evil.test/'],
    ['a site without a scheme', '//evil.test/'],
    ['a site through a backslash', '/\\\\evil.test/'],
    ['a script', 'javascript:alert(1)'],
    ['the callback itself', '/callback?code=x'],
    ['not a string', 42],
  ])('refuses %s', (_label, returnTo) => {
    expect(safeReturnPath({ returnTo })).toBe('/');
  });

  it('copes with no state', () => {
    expect(safeReturnPath(undefined)).toBe('/');
  });
});
