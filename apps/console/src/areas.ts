// SPDX-License-Identifier: AGPL-3.0-only
// Who sees which area (LLD-04 §1). This only shapes the navigation: console-api enforces
// access on every request, whatever this app shows.
import type { Me } from './api';

export type AreaId = 'provider' | 'tenant' | 'department' | 'account';

export interface NavItem {
  path: string;
  labelKey: string;
}

export interface Area {
  id: AreaId;
  labelKey: string;
  items: NavItem[];
}

const item = (area: string, screen: string): NavItem => ({
  path: `/${area}/${screen}`,
  labelKey: `nav.${area}.${screen}`,
});

const ALL: Area[] = [
  {
    id: 'provider',
    labelKey: 'area.provider',
    items: ['tenants', 'plans', 'models', 'router', 'usage', 'audit'].map((s) =>
      item('provider', s),
    ),
  },
  {
    id: 'tenant',
    labelKey: 'area.tenant',
    items: [
      'overview',
      'users',
      'departments',
      'requests',
      'policies',
      'access',
      'identity',
      'usage',
      'billing',
      'audit',
    ].map((s) => item('tenant', s)),
  },
  {
    id: 'department',
    labelKey: 'area.department',
    items: ['overview', 'users', 'requests', 'usage'].map((s) => item('department', s)),
  },
  {
    id: 'account',
    labelKey: 'area.account',
    items: ['usage', 'requests', 'sessions', 'privacy', 'preferences'].map((s) =>
      item('account', s),
    ),
  },
];

/** The areas this caller may see, most useful first. */
export function areasFor(me: Pick<Me, 'roles' | 'user'>): Area[] {
  const wanted = new Set<AreaId>();
  if (me.roles.includes('provider_admin') && !me.user) wanted.add('provider');
  if (me.user) {
    if (me.roles.includes('tenant_admin')) wanted.add('tenant');
    if (me.roles.includes('dept_manager')) wanted.add('department');
    wanted.add('account');
  }
  return ALL.filter((a) => wanted.has(a.id));
}

export const canOpen = (me: Pick<Me, 'roles' | 'user'>, path: string): boolean =>
  areasFor(me).some((a) => a.items.some((i) => i.path === path));

export const homeOf = (me: Pick<Me, 'roles' | 'user'>): string | null =>
  areasFor(me)[0]?.items[0]?.path ?? null;

export const ALL_AREAS = ALL;
