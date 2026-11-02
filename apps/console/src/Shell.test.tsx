// SPDX-License-Identifier: AGPL-3.0-only
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Me } from './api';
import { Shell } from './components/Shell';
import i18n from './i18n';

const user = { id: 'u', email: 'ayse@acme.test', name: 'Ayşe', role: 'user' };
const tenant = { id: 't', slug: 'acme', name: 'Acme A.Ş.', status: 'active' };

const show = (me: Me, onSignOut = () => {}) =>
  render(
    <MemoryRouter>
      <Shell me={me} chatUrl={me.tenant ? 'https://acme.test' : null} onSignOut={onSignOut}>
        <p>content</p>
      </Shell>
    </MemoryRouter>,
  );

beforeEach(async () => {
  await i18n.changeLanguage('tr');
});
afterEach(cleanup);

describe('the shell', () => {
  it('shows a user only their account', () => {
    show({ roles: ['user'], tenant, user });
    expect(screen.queryByTestId('area-account')).not.toBeNull();
    expect(screen.queryByTestId('area-tenant')).toBeNull();
    expect(screen.queryByTestId('area-provider')).toBeNull();
    expect(screen.queryByTestId('nav-tenant-users')).toBeNull();
  });

  it('shows a tenant admin their company', () => {
    show({ roles: ['tenant_admin'], tenant, user });
    expect(screen.getByTestId('nav-tenant-users').textContent).toBe('Kullanıcılar');
    expect(screen.getByText('Acme A.Ş.')).toBeTruthy();
    expect(screen.getByTestId('open-chat').getAttribute('href')).toBe('https://acme.test');
  });

  it('gives a provider admin no chat link', () => {
    show({ roles: ['provider_admin'], tenant: null, user: null });
    expect(screen.queryByTestId('open-chat')).toBeNull();
    expect(screen.queryByTestId('area-provider')).not.toBeNull();
  });

  it('starts in Turkish and switches to English', async () => {
    show({ roles: ['tenant_admin'], tenant, user });
    expect(document.documentElement.lang).toBe('tr');
    fireEvent.change(screen.getByTestId('language'), { target: { value: 'en' } });
    expect((await screen.findByTestId('nav-tenant-users')).textContent).toBe('Users');
    expect(document.documentElement.lang).toBe('en');
    expect(screen.getByTestId('sign-out').textContent).toBe('Sign out');
  });

  it('signs out', () => {
    const onSignOut = vi.fn();
    show({ roles: ['user'], tenant, user }, onSignOut);
    fireEvent.click(screen.getByTestId('sign-out'));
    expect(onSignOut).toHaveBeenCalledOnce();
  });

  it('has a navigation landmark and a way to skip it', () => {
    show({ roles: ['user'], tenant, user });
    expect(screen.getByRole('navigation')).toBeTruthy();
    expect(screen.getByRole('main').id).toBe('main');
    expect(screen.getByText('Ana içeriğe geç').getAttribute('href')).toBe('#main');
  });
});
