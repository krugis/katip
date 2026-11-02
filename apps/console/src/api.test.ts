// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch } from './api';
import { dataProviderFor } from './data-provider';

const respond = (status: number, body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );

afterEach(() => vi.unstubAllGlobals());

describe('apiFetch', () => {
  it('sends the token, to our own API', async () => {
    respond(200, { ok: true });
    await apiFetch('/me', async () => 'tok');
    expect(fetch).toHaveBeenCalledWith('/api/v1/me', { headers: { authorization: 'Bearer tok' } });
  });

  it('turns a problem into an error with its code', async () => {
    respond(403, { code: 'user_disabled' });
    await expect(apiFetch('/me', async () => 'tok')).rejects.toMatchObject({
      status: 403,
      code: 'user_disabled',
    });
  });

  it('copes with an error that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>', { status: 502 })),
    );
    await expect(apiFetch('/me', async () => 'tok')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('the data provider', () => {
  it('finds a list under its own name', async () => {
    respond(200, { tenants: [{ id: '1' }, { id: '2' }] });
    const provider = dataProviderFor(async () => 'tok');
    const result = await provider.getList({ resource: 'admin/tenants' });
    expect(result).toEqual({ data: [{ id: '1' }, { id: '2' }], total: 2 });
  });
});
