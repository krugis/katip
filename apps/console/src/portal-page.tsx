// SPDX-License-Identifier: AGPL-3.0-only
// "My account", and where a company admin answers what people ask (LLD-04 §1.4, P1-32).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetch, apiSend, type GetToken, type Me } from './api';
import { Button } from './components/ui';
import { LanguageSwitch } from './components/Shell';
import type { AppConfig } from './config';
import { saveFile, UsageReport } from './usage-page';

interface OwnRequest {
  id: string;
  type: string;
  reason: string;
  status: string;
  createdAt: string;
  decidedAt: string | null;
}
interface PrivacyRequest {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

const SECTION = 'rounded-lg border border-line bg-surface p-4';
const HELP = 'mt-1 text-sm text-muted';

function useProblem() {
  const { t } = useTranslation();
  return (e: unknown) =>
    t(`errors.${e instanceof ApiError ? e.code : 'generic'}`, {
      defaultValue: t('errors.generic'),
    });
}

function useDate() {
  const { i18n } = useTranslation();
  const format = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (iso: string) => format.format(new Date(iso));
}

export function AccountUsage({ getToken }: { getToken: GetToken }) {
  const { t } = useTranslation();
  return (
    <div>
      <h1 className="text-xl font-semibold">{t('nav.account.usage')}</h1>
      <UsageReport path="/me/usage" groups={['model', 'day']} getToken={getToken} noExport />
    </div>
  );
}

export function AccountRequests({ getToken }: { getToken: GetToken }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const problem = useProblem();
  const date = useDate();
  const mine = useQuery({
    queryKey: ['my-requests'],
    queryFn: () => apiFetch<{ requests: OwnRequest[] }>('/me/requests', getToken),
  });
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError(null);
    setSent(false);
    try {
      await apiSend('POST', '/me/requests', getToken, {
        type: data.get('type'),
        reason: String(data.get('reason')).trim(),
      });
      form.reset();
      setSent(true);
      await client.invalidateQueries({ queryKey: ['my-requests'] });
    } catch (err) {
      setError(problem(err));
    }
  };

  const rows = mine.data?.requests ?? [];
  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('nav.account.requests')}</h1>
      <form
        onSubmit={(e) => void submit(e)}
        data-testid="request-form"
        className={`mt-4 ${SECTION}`}
      >
        <label className="block text-sm font-medium">
          {t('account.requestType')}
          <select
            name="type"
            data-testid="request-type"
            className="mt-1 block w-full max-w-sm rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          >
            {(['premium_access', 'budget', 'model'] as const).map((type) => (
              <option key={type} value={type}>
                {t(`department.requestType.${type}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="mt-3 block text-sm font-medium">
          {t('account.reason')}
          <textarea
            name="reason"
            rows={3}
            required
            maxLength={1000}
            data-testid="request-reason"
            className="mt-1 w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm"
          />
        </label>
        <p className={HELP}>{t('account.reasonHelp')}</p>
        <Button variant="primary" type="submit" className="mt-3" data-testid="request-send">
          {t('account.send')}
        </Button>
        {sent && (
          <p className="mt-2 text-sm text-muted" role="status" data-testid="request-sent">
            {t('account.sent')}
          </p>
        )}
        {error && (
          <p className="mt-2 text-sm text-danger" role="alert" data-testid="form-error">
            {error}
          </p>
        )}
      </form>
      {mine.isSuccess && rows.length === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="no-my-requests">
          {t('account.noRequests')}
        </p>
      )}
      {rows.length > 0 && (
        <ul
          className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface"
          data-testid="my-requests"
        >
          {rows.map((r) => (
            <li key={r.id} className="p-3 text-sm" data-status={r.status}>
              <div className="font-medium">
                {t(`department.requestType.${r.type}`, { defaultValue: r.type })} ·{' '}
                {t(`department.status.${r.status}`, { defaultValue: r.status })}
              </div>
              <div className="text-muted">{date(r.createdAt)}</div>
              <p className="mt-1 whitespace-pre-wrap">{r.reason}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AccountSessions({ config }: { config: AppConfig }) {
  const { t } = useTranslation();
  const account = `${config.authority}/account`;
  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('nav.account.sessions')}</h1>
      <div className={`mt-4 ${SECTION}`}>
        <p className="text-sm">{t('account.sessionsHelp')}</p>
        <a
          href={account}
          data-testid="keycloak-account"
          className="mt-3 inline-block text-sm text-accent underline underline-offset-2"
        >
          {t('account.openAccount')}
        </a>
      </div>
    </div>
  );
}

export function AccountPrivacy({ getToken }: { getToken: GetToken }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const problem = useProblem();
  const date = useDate();
  const mine = useQuery({
    queryKey: ['my-privacy'],
    queryFn: () => apiFetch<{ requests: PrivacyRequest[] }>('/me/privacy', getToken),
  });
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setError(null);
    try {
      const data = await apiSend('POST', '/me/privacy/export', getToken);
      saveFile('my-data.json', JSON.stringify(data, null, 2), 'application/json');
      await client.invalidateQueries({ queryKey: ['my-privacy'] });
    } catch (e) {
      setError(problem(e));
    }
  };
  const askDeletion = async () => {
    if (!window.confirm(t('account.confirmDelete'))) return;
    setError(null);
    try {
      await apiSend('POST', '/me/privacy/delete', getToken);
      await client.invalidateQueries({ queryKey: ['my-privacy'] });
    } catch (e) {
      setError(problem(e));
    }
  };
  const rows = mine.data?.requests ?? [];

  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">{t('nav.account.privacy')}</h1>
      <section className={SECTION}>
        <h2 className="text-sm font-medium">{t('account.exportTitle')}</h2>
        <p className={HELP}>{t('account.exportHelp')}</p>
        <Button className="mt-3" data-testid="privacy-export" onClick={() => void download()}>
          {t('account.exportButton')}
        </Button>
      </section>
      <section className={SECTION}>
        <h2 className="text-sm font-medium">{t('account.deleteTitle')}</h2>
        <p className={HELP}>{t('account.deleteHelp')}</p>
        <Button className="mt-3" data-testid="privacy-delete" onClick={() => void askDeletion()}>
          {t('account.deleteButton')}
        </Button>
      </section>
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
      {rows.length > 0 && (
        <ul
          className="divide-y divide-line rounded-lg border border-line bg-surface"
          data-testid="my-privacy"
        >
          {rows.map((r) => (
            <li key={r.id} className="p-3 text-sm" data-type={r.type} data-status={r.status}>
              {t(`account.privacyType.${r.type}`, { defaultValue: r.type })} ·{' '}
              {t(`account.privacyStatus.${r.status}`, { defaultValue: r.status })} ·{' '}
              <span className="text-muted">{date(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AccountPreferences() {
  const { t } = useTranslation();
  return (
    <div className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('nav.account.preferences')}</h1>
      <div className={`mt-4 ${SECTION}`}>
        <LanguageSwitch />
        <p className={HELP}>{t('account.preferencesHelp')}</p>
      </div>
    </div>
  );
}

// ---- what a company admin answers --------------------------------------------------------

interface AdminRequest extends OwnRequest {
  userName: string;
  userEmail: string;
}
interface AdminPrivacy extends PrivacyRequest {
  userName: string;
  userEmail: string;
}

export function TenantRequests({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const problem = useProblem();
  const date = useDate();
  const base = `/tenants/${me.tenant!.id}`;
  const all = useQuery({
    queryKey: ['tenant-requests', base],
    queryFn: () =>
      apiFetch<{ requests: AdminRequest[]; privacy: AdminPrivacy[] }>(`${base}/requests`, getToken),
  });
  const [error, setError] = useState<string | null>(null);
  const act = async (path: string, body: object) => {
    setError(null);
    try {
      await apiSend('PATCH', `${base}${path}`, getToken, body);
      await client.invalidateQueries({ queryKey: ['tenant-requests', base] });
    } catch (e) {
      setError(problem(e));
    }
  };
  const requests = all.data?.requests ?? [];
  const privacy = all.data?.privacy ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-xl font-semibold">{t('nav.tenant.requests')}</h1>
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
      <section>
        <h2 className="text-sm font-medium">{t('account.privacyRequests')}</h2>
        <p className={HELP}>{t('account.privacyRequestsHelp')}</p>
        {all.isSuccess && privacy.length === 0 && (
          <p className="mt-2 text-sm text-muted">{t('account.noPrivacyRequests')}</p>
        )}
        {privacy.length > 0 && (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            {privacy.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm"
                data-testid={`privacy-${p.userEmail}-${p.type}`}
                data-status={p.status}
              >
                <div>
                  <div className="font-medium">
                    {t(`account.privacyType.${p.type}`, { defaultValue: p.type })} · {p.userName}
                  </div>
                  <div className="text-muted">
                    {p.userEmail} · {date(p.createdAt)} ·{' '}
                    {t(`account.privacyStatus.${p.status}`, { defaultValue: p.status })}
                  </div>
                </div>
                {p.status === 'pending' && p.type === 'delete' && (
                  <Button
                    data-testid="privacy-approve"
                    onClick={() => {
                      if (
                        window.confirm(t('account.approveDeletionConfirm', { name: p.userName }))
                      ) {
                        void act(`/privacy-requests/${p.id}`, { status: 'approved' });
                      }
                    }}
                  >
                    {t('account.approveDeletion')}
                  </Button>
                )}
                {p.status === 'pending' && p.type !== 'delete' && (
                  <Button
                    data-testid="privacy-complete"
                    onClick={() => void act(`/privacy-requests/${p.id}`, { status: 'completed' })}
                  >
                    {t('account.markDone')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="text-sm font-medium">{t('account.otherRequests')}</h2>
        {all.isSuccess && requests.length === 0 && (
          <p className="mt-2 text-sm text-muted">{t('department.noRequests')}</p>
        )}
        {requests.length > 0 && (
          <ul className="mt-2 divide-y divide-line rounded-lg border border-line bg-surface">
            {requests.map((r) => (
              <li
                key={r.id}
                className="p-3 text-sm"
                data-testid={`tenant-request-${r.userEmail}`}
                data-status={r.status}
              >
                <div className="font-medium">
                  {t(`department.requestType.${r.type}`, { defaultValue: r.type })} · {r.userName}
                </div>
                <div className="text-muted">
                  {r.userEmail} · {date(r.createdAt)}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{r.reason}</p>
                {r.status === 'pending' ? (
                  <div className="mt-2 flex gap-2">
                    <Button
                      variant="primary"
                      data-testid="approve"
                      onClick={() => void act(`/requests/${r.id}`, { status: 'approved' })}
                    >
                      {t('department.approve')}
                    </Button>
                    <Button
                      data-testid="reject"
                      onClick={() => void act(`/requests/${r.id}`, { status: 'rejected' })}
                    >
                      {t('department.reject')}
                    </Button>
                  </div>
                ) : (
                  <p className="mt-1 text-muted">
                    {t(`department.status.${r.status}`, { defaultValue: r.status })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
