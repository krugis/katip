// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { Me } from './api';
import { ALL_AREAS, areasFor, canOpen, homeOf } from './areas';
import en from './locales/en.json';
import tr from './locales/tr.json';

const user = { id: 'u', email: 'a@b.test', name: 'A', role: 'user' };
const provider: Me = { roles: ['provider_admin'], tenant: null, user: null };
const person = (...roles: string[]): Me => ({ roles, tenant: null, user });

describe('who sees which area', () => {
  it.each<[string, Me, string[]]>([
    ['a provider admin', provider, ['provider']],
    ['a tenant admin', person('tenant_admin'), ['tenant', 'account']],
    ['a department manager', person('dept_manager'), ['department', 'account']],
    ['a user', person('user'), ['account']],
    ['someone with no role', person(), ['account']],
    [
      'an admin who also manages',
      person('tenant_admin', 'dept_manager'),
      ['tenant', 'department', 'account'],
    ],
  ])('%s', (_label, me, expected) => {
    expect(areasFor(me).map((a) => a.id)).toEqual(expected);
  });

  it('a customer holding the provider role does not get the provider area', () => {
    expect(areasFor(person('provider_admin')).map((a) => a.id)).toEqual(['account']);
  });

  it('opens only the screens of its areas', () => {
    expect(canOpen(person('user'), '/account/usage')).toBe(true);
    expect(canOpen(person('user'), '/tenant/users')).toBe(false);
    expect(canOpen(person('user'), '/provider/tenants')).toBe(false);
    expect(canOpen(person('tenant_admin'), '/tenant/users')).toBe(true);
    expect(canOpen(person('tenant_admin'), '/department/overview')).toBe(false);
    expect(canOpen(provider, '/provider/tenants')).toBe(true);
    expect(canOpen(provider, '/account/usage')).toBe(false);
    expect(canOpen(person('user'), '/nowhere')).toBe(false);
  });

  it('starts each role on its first area', () => {
    expect(homeOf(provider)).toBe('/provider/tenants');
    expect(homeOf(person('tenant_admin'))).toBe('/tenant/overview');
    expect(homeOf(person('dept_manager'))).toBe('/department/overview');
    expect(homeOf(person('user'))).toBe('/account/usage');
  });
});

describe('translations', () => {
  const flatten = (o: object, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      typeof v === 'object' ? flatten(v as object, `${prefix}${k}.`) : [`${prefix}${k}`],
    );
  const lookup = (o: object, key: string): unknown =>
    key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], o);

  it('have the same keys in Turkish and English', () => {
    expect(flatten(tr).sort()).toEqual(flatten(en).sort());
  });

  it('name every area and screen', () => {
    for (const area of ALL_AREAS) {
      for (const key of [area.labelKey, ...area.items.map((i) => i.labelKey)]) {
        expect(lookup(tr, key), key).toEqual(expect.any(String));
        expect(lookup(en, key), key).toEqual(expect.any(String));
      }
    }
  });

  it('are really translated', () => {
    const same = flatten(tr).filter((k) => lookup(tr, k) === lookup(en, k));
    expect(same).toEqual(['app.name']);
  });
});
