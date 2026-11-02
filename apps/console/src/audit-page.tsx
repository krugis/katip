// SPDX-License-Identifier: AGPL-3.0-only
// The audit log, for a company admin and for us (LLD-04 §1, tracker P1-33).
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch, type GetToken, type Me } from './api';
import { Button } from './components/ui';

interface Entry {
  id: string;
  ts: string;
  action: string;
  actorType: string;
  actor: string | null;
  targetType: string;
  targetId: string | null;
  details: Record<string, unknown> | null;
  tenantSlug?: string;
}
interface Page {
  entries: Entry[];
  next: string | null;
}

const ACTIONS = [
  'user.invite',
  'user.update',
  'department.create',
  'department.update',
  'policy.update',
  'access_rules.update',
  'request.create',
  'request.decide',
  'privacy.export',
  'privacy.delete_request',
  'privacy.complete',
  'tenant.create',
  'tenant.suspend',
  'tenant.resume',
  'tenant.delete',
  'tenant.restore',
  'tenant.purge',
];

function AuditLog({
  path,
  title,
  showTenant,
  getToken,
}: {
  path: string;
  title: string;
  showTenant: boolean;
  getToken: GetToken;
}) {
  const { t, i18n } = useTranslation();
  const [action, setAction] = useState('');
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium' });
  const log = useInfiniteQuery({
    queryKey: ['audit', path, action],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams();
      if (action) query.set('action', action);
      if (pageParam) query.set('before', pageParam);
      return apiFetch<Page>(`${path}?${query}`, getToken);
    },
    getNextPageParam: (last) => last.next,
  });
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <div>
      <h1 className="text-xl font-semibold">{title}</h1>
      <label className="mt-4 block text-sm font-medium">
        {t('audit.filter')}
        <select
          data-testid="audit-action"
          className="mt-1 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">{t('audit.all')}</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {t(`audit.action.${a.replace('.', '_')}`, { defaultValue: a })}
            </option>
          ))}
        </select>
      </label>
      {log.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {log.isError && (
        <p className="mt-4 text-sm text-danger" role="alert">
          {t('errors.generic')}
        </p>
      )}
      {log.isSuccess && entries.length === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="audit-empty">
          {t('audit.empty')}
        </p>
      )}
      {entries.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm" data-testid="audit-table">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('audit.when')}</th>
                {showTenant && <th className="px-3 py-2 font-medium">{t('tenants.slug')}</th>}
                <th className="px-3 py-2 font-medium">{t('audit.who')}</th>
                <th className="px-3 py-2 font-medium">{t('audit.what')}</th>
                <th className="px-3 py-2 font-medium">{t('audit.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-line align-top last:border-b-0"
                  data-action={e.action}
                >
                  <td className="whitespace-nowrap px-3 py-2 text-muted">
                    {date.format(new Date(e.ts))}
                  </td>
                  {showTenant && <td className="px-3 py-2 font-mono text-xs">{e.tenantSlug}</td>}
                  <td className="px-3 py-2">
                    {e.actorType === 'user'
                      ? (e.actor ?? t('audit.deletedUser'))
                      : t(`audit.actorType.${e.actorType}`, { defaultValue: e.actorType })}
                  </td>
                  <td className="px-3 py-2">
                    {t(`audit.action.${e.action.replace('.', '_')}`, { defaultValue: e.action })}
                  </td>
                  <td className="max-w-sm break-all px-3 py-2 font-mono text-xs text-muted">
                    {e.details && Object.keys(e.details).length > 0
                      ? JSON.stringify(e.details)
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage && (
        <Button
          className="mt-3"
          data-testid="audit-more"
          disabled={log.isFetchingNextPage}
          onClick={() => void log.fetchNextPage()}
        >
          {t('audit.more')}
        </Button>
      )}
    </div>
  );
}

export function TenantAudit({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  return (
    <AuditLog
      path={`/tenants/${me.tenant!.id}/audit`}
      title={t('nav.tenant.audit')}
      showTenant={false}
      getToken={getToken}
    />
  );
}

export function ProviderAudit({ getToken }: { getToken: GetToken }) {
  const { t } = useTranslation();
  return (
    <AuditLog path="/admin/audit" title={t('nav.provider.audit')} showTenant getToken={getToken} />
  );
}
