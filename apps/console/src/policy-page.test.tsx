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

const enforcing = { months: 12, inForce: 12, notice: null };

const show = async (retention: object = enforcing, who: api.Me = me) => {
  vi
    .spyOn(api, 'apiFetch')
    .mockImplementation(async (path: string) =>
      path.endsWith('/chat-retention') ? retention : policy,
    ) as never;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TenantPolicies me={who} getToken={async () => 'token'} />
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
    expect(confirm.mock.calls[0]![0]).toContain('e-posta');
    expect(confirm.mock.calls[0]![0]).toContain('30 gün');
    expect(send).not.toHaveBeenCalled();
  });

  const status = () => screen.getByTestId('chat-retention-status');
  const told = { notifiedAt: '2026-11-04T10:00:00.000Z', startsAt: '2026-12-04T10:00:00.000Z' };

  it('says nothing is going yet, before the first notice', async () => {
    await show({ months: 12, inForce: null, notice: null });
    expect(status().textContent).toContain('Henüz hiçbir sohbet silinmiyor');
  });

  it('says what is in force when nothing is waiting', async () => {
    await show();
    expect(status().textContent).toContain('12 aydan');
  });

  it('says a notice is going out and no date yet', async () => {
    await show({
      months: 6,
      inForce: 12,
      notice: { months: 6, notifiedAt: null, startsAt: null },
    });
    expect(status().textContent).toContain('12 ay sonra');
    expect(status().textContent).toContain('6 aylık');
    expect(status().dataset['state']).toBe('sendingWhile');
  });

  it('says when a first deletion starts', async () => {
    await show({ months: 12, inForce: null, notice: { months: 12, ...told } });
    expect(status().textContent).toContain('2026');
    expect(status().dataset['state']).toBe('starts');
  });

  it('says what changes on the date, for a shorter period', async () => {
    await show({ months: 6, inForce: 12, notice: { months: 6, ...told } });
    expect(status().textContent).toContain('2026');
    expect(status().textContent).toContain('12 ay');
    expect(status().textContent).toContain('6 ay');
    expect(status().dataset['state']).toBe('startsWhile');
  });

  it('offers no way to change it to someone who is not the company admin', async () => {
    const input = await show(enforcing, {
      ...me,
      roles: ['provider_admin'],
    } as api.Me);
    expect(input.disabled).toBe(true);
    expect(screen.queryByTestId('chat-retention-save')).toBeNull();
    expect(screen.getByTestId('chat-retention-read-only').textContent).toContain('yöneticileri');
  });

  it('saves on its own, without sending the policy', async () => {
    const send = vi
      .spyOn(api, 'apiSend')
      .mockResolvedValue({ months: 6, inForce: 12, notice: null });
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
    vi.spyOn(api, 'apiSend').mockResolvedValue({ months: 24, inForce: 24, notice: null });
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
