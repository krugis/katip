// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import i18n from './i18n';
import { TenantPolicies } from './policy-page';

const me = {
  roles: ['tenant_admin'],
  tenant: { id: 't', slug: 'acme', name: 'Acme A.Ş.', status: 'active' },
  user: { id: 'u', email: 'a@acme.test', name: 'A', role: 'tenant_admin' },
} as api.Me;
const policy = {
  policy: {
    aliases: { auto: true, fast: true, best: true, 'tr-local': false },
    allowUserModelChoice: false,
    allowedModels: [],
    atQuotaLimit: 'downgrade',
    residency: 'ANY_APPROVED',
    pii: { mode: 'mask' },
  },
  version: 1,
  kvkkAddon: false,
  catalog: [],
};

const show = async () => {
  vi
    .spyOn(api, 'apiFetch')
    .mockImplementation(async (path: string) =>
      path.endsWith('/chat-retention') ? { months: 12 } : policy,
    ) as never;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TenantPolicies me={me} getToken={async () => 'token'} />
    </QueryClientProvider>,
  );
  return (await screen.findByTestId('chat-retention-months')) as HTMLInputElement;
};

beforeEach(async () => {
  await i18n.changeLanguage('tr');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the chat retention setting', () => {
  it('shows the period, and says plainly that deleting is permanent', async () => {
    const input = await show();
    expect(input.value).toBe('12');
    expect(input.min).toBe('1');
    expect(input.max).toBe('120');
    expect(screen.getByTestId('chat-retention-form').textContent).toContain('geri alınamaz');
    await i18n.changeLanguage('en');
    expect((await screen.findByTestId('chat-retention-form')).textContent).toContain(
      'cannot be undone',
    );
  });

  it('asks first when shortening it, and sends nothing if the answer is no', async () => {
    const send = vi.spyOn(api, 'apiSend').mockResolvedValue({ months: 6 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const input = await show();
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('chat-retention-save'));
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]![0]).toContain('6 aydan');
    expect(send).not.toHaveBeenCalled();
  });

  it('saves on its own, without sending the policy', async () => {
    const send = vi.spyOn(api, 'apiSend').mockResolvedValue({ months: 6 });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const input = await show();
    fireEvent.change(input, { target: { value: '6' } });
    fireEvent.click(screen.getByTestId('chat-retention-save'));
    await screen.findByTestId('chat-retention-saved');
    expect(send).toHaveBeenCalledWith('PUT', '/tenants/t/chat-retention', expect.anything(), {
      months: 6,
    });
    await waitFor(() => expect(input.value).toBe('6'));
  });

  it("doesn't ask when making it longer", async () => {
    vi.spyOn(api, 'apiSend').mockResolvedValue({ months: 24 });
    const confirm = vi.spyOn(window, 'confirm');
    const input = await show();
    fireEvent.change(input, { target: { value: '24' } });
    fireEvent.click(screen.getByTestId('chat-retention-save'));
    await screen.findByTestId('chat-retention-saved');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('says so if it could not save', async () => {
    vi.spyOn(api, 'apiSend').mockRejectedValue(new Error('no'));
    const input = await show();
    fireEvent.change(input, { target: { value: '24' } });
    fireEvent.click(screen.getByTestId('chat-retention-save'));
    await screen.findByTestId('chat-retention-error');
    expect(screen.queryByTestId('chat-retention-saved')).toBeNull();
  });
});
