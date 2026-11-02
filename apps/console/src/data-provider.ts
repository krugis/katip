// SPDX-License-Identifier: AGPL-3.0-only
// Refine's window on console-api. Lists are all it needs so far: the screens that change
// things bring what they need with them.
import type { BaseRecord, DataProvider } from '@refinedev/core';
import { apiFetch, type GetToken } from './api';

export interface TenantRow extends BaseRecord {
  id: string;
  slug: string;
  name: string;
  status: string;
}

const notYet = (what: string) => () => Promise.reject(new Error(`${what} isn't available yet`));

export function dataProviderFor(getToken: GetToken): DataProvider {
  return {
    getApiUrl: () => '/api/v1',
    getList: async ({ resource }) => {
      const body = await apiFetch<Record<string, unknown[]>>(`/${resource}`, getToken);
      // Each list comes under its own name, such as `tenants` for `admin/tenants`.
      const data = (body[resource.split('/').at(-1) ?? ''] ?? []) as never[];
      return { data, total: data.length };
    },
    getOne: notYet('getOne'),
    create: notYet('create'),
    update: notYet('update'),
    deleteOne: notYet('deleteOne'),
  };
}
