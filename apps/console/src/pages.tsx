// SPDX-License-Identifier: AGPL-3.0-only
import { useList } from '@refinedev/core';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { TenantRow } from './data-provider';
import { Button, Message } from './components/ui';
import type { GetToken } from './api';
import { DailyJobStatus } from './daily-jobs';

/** A screen in the navigation whose own task hasn't arrived yet. */
export function ComingSoon({ labelKey }: { labelKey: string }) {
  const { t } = useTranslation();
  return (
    <div data-testid="coming-soon">
      <h1 className="text-xl font-semibold">{t(labelKey)}</h1>
      <div className="mt-4 max-w-lg rounded-lg border border-line bg-surface p-4">
        <p className="text-sm font-medium">{t('page.soonTitle')}</p>
        <p className="mt-1 text-sm text-muted">{t('page.soonBody')}</p>
      </div>
    </div>
  );
}

export function NoAccess({ home }: { home: string | null }) {
  const { t } = useTranslation();
  return (
    <Message title={t('problem.noAccessTitle')} testId="no-access">
      <p>{t('problem.noAccessBody')}</p>
      {home && (
        <Link className="text-accent underline underline-offset-2" to={home}>
          {t('problem.home')}
        </Link>
      )}
    </Message>
  );
}

/** Why we can't show anything at all, and a way to try again. */
export function AccountProblem({
  code,
  onRetry,
  onSignOut,
}: {
  code: string;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const known = ['user_disabled', 'user_not_provisioned', 'forbidden', 'signInFailed'];
  return (
    <Message title={t('problem.title')} testId="account-problem">
      <p data-testid="problem-code" data-code={code}>
        {t(`problem.${known.includes(code) ? code : 'unavailable'}`)}
      </p>
      <div className="flex gap-2">
        <Button onClick={onRetry}>{t('problem.retry')}</Button>
        {/* So someone can switch to another account. */}
        <Button data-testid="problem-sign-out" onClick={onSignOut}>
          {t('app.signOut')}
        </Button>
      </div>
    </Message>
  );
}

export function ProviderTenants({ getToken }: { getToken: GetToken }) {
  const { t } = useTranslation();
  const { result, query } = useList<TenantRow>({
    resource: 'admin/tenants',
    pagination: { mode: 'off' },
  });
  return (
    <div>
      <h1 className="text-xl font-semibold">{t('nav.provider.tenants')}</h1>
      <DailyJobStatus getToken={getToken} />
      {query.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {query.isError && (
        <p className="mt-4 text-sm text-danger" role="alert">
          {t('tenants.error')}
        </p>
      )}
      {query.isSuccess && result.data.length === 0 && (
        <p className="mt-4 text-sm text-muted">{t('tenants.empty')}</p>
      )}
      {query.isSuccess && result.data.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm" data-testid="tenants">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('tenants.name')}</th>
                <th className="px-3 py-2 font-medium">{t('tenants.slug')}</th>
                <th className="px-3 py-2 font-medium">{t('tenants.status')}</th>
              </tr>
            </thead>
            <tbody>
              {result.data.map((row) => (
                <tr key={row.id} className="border-b border-line last:border-b-0">
                  <td className="px-3 py-2">{row.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{row.slug}</td>
                  <td className="px-3 py-2">{t(`tenants.statusValue.${row.status}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
