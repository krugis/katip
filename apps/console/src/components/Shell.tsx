// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router';
import type { Me } from '../api';
import { areasFor } from '../areas';
import { LANGUAGES, setLanguage, type Language } from '../i18n';
import { Button } from './ui';

export function LanguageSwitch() {
  const { t, i18n } = useTranslation();
  return (
    <label className="flex items-center gap-2 text-sm text-muted">
      {t('app.language')}
      <select
        data-testid="language"
        className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
        value={i18n.language}
        onChange={(e) => setLanguage(e.target.value as Language)}
      >
        {LANGUAGES.map((l) => (
          <option key={l} value={l}>
            {l === 'tr' ? 'Türkçe' : 'English'}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Shell({
  me,
  chatUrl,
  onSignOut,
  children,
}: {
  me: Me;
  chatUrl: string | null;
  onSignOut: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[16rem_1fr]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-10 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        {t('app.skip')}
      </a>
      <aside className="border-b border-line bg-surface md:border-b-0 md:border-r">
        <div className="px-4 py-4">
          <div className="text-lg font-semibold">{t('app.name')}</div>
          {me.tenant && <div className="truncate text-sm text-muted">{me.tenant.name}</div>}
        </div>
        <nav aria-label={t('app.navigation')} className="space-y-5 px-2 pb-6">
          {areasFor(me).map((area) => (
            <div key={area.id} data-testid={`area-${area.id}`}>
              <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted">
                {t(area.labelKey)}
              </div>
              <ul>
                {area.items.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      data-testid={`nav${item.path.replaceAll('/', '-')}`}
                      className={({ isActive }) =>
                        `block rounded-md px-2 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-accent ${
                          isActive
                            ? 'bg-accent-soft font-medium text-accent'
                            : 'hover:bg-accent-soft'
                        }`
                      }
                    >
                      {t(item.labelKey)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-center justify-end gap-3 border-b border-line bg-surface px-4 py-2">
          {chatUrl && (
            <a
              href={chatUrl}
              data-testid="open-chat"
              className="text-sm text-accent underline-offset-2 hover:underline"
            >
              {t('app.openChat')}
            </a>
          )}
          <LanguageSwitch />
          {me.user && (
            <span className="max-w-48 truncate text-sm text-muted" data-testid="who">
              {me.user.email}
            </span>
          )}
          <Button data-testid="sign-out" onClick={onSignOut}>
            {t('app.signOut')}
          </Button>
        </header>
        <main id="main" className="flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
