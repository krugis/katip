// SPDX-License-Identifier: AGPL-3.0-only
// A department manager's screens (LLD-04 §1.3, tracker P1-31).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetch, apiSend, type GetToken, type Me } from './api';
import { Button } from './components/ui';
import { UsageReport } from './usage-page';

interface MyDepartment {
  id: string;
  name: string;
  budgetUsdMicro: number | null;
  userCount: number;
}
interface Person {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  seatPlanCode: string | null;
}
interface Request {
  id: string;
  type: string;
  reason: string;
  status: string;
  userName: string;
  userEmail: string;
  createdAt: string;
  decidedAt: string | null;
}

/** Remembered across screens in this tab: a manager often has only the one. */
let lastChosen: string | null = null;

function WithDepartment({
  me,
  getToken,
  title,
  children,
}: {
  me: Me;
  getToken: GetToken;
  title: string;
  children: (department: MyDepartment, base: string) => ReactNode;
}) {
  const { t } = useTranslation();
  const base = `/tenants/${me.tenant!.id}`;
  const mine = useQuery({
    queryKey: ['my-departments', base],
    queryFn: () => apiFetch<{ departments: MyDepartment[] }>(`${base}/my-departments`, getToken),
  });
  const [chosen, setChosen] = useState(lastChosen);
  const departments = mine.data?.departments ?? [];
  const department = departments.find((d) => d.id === chosen) ?? departments[0];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {departments.length > 1 && (
          <label className="text-sm text-muted">
            {t('department.choose')}{' '}
            <select
              data-testid="department-choice"
              className="rounded-md border border-line bg-surface px-2 py-1 text-ink"
              value={department?.id}
              onChange={(e) => {
                lastChosen = e.target.value;
                setChosen(e.target.value);
              }}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mine.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {mine.isError && (
        <p className="mt-4 text-sm text-danger" role="alert">
          {t('errors.generic')}
        </p>
      )}
      {mine.isSuccess && !department && (
        <p className="mt-4 text-sm text-muted" data-testid="no-department">
          {t('department.none')}
        </p>
      )}
      {department && children(department, `${base}/departments/${department.id}`)}
    </div>
  );
}

export function DepartmentOverview({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t, i18n } = useTranslation();
  const money = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' });
  return (
    <WithDepartment me={me} getToken={getToken} title={t('nav.department.overview')}>
      {(d) => (
        <div
          className="mt-4 max-w-lg rounded-lg border border-line bg-surface p-4"
          data-testid="department-summary"
        >
          <p className="font-medium">{d.name}</p>
          <p className="mt-1 text-sm text-muted">
            {t('departments.people', { count: d.userCount })}
          </p>
          <p className="text-sm text-muted">
            {d.budgetUsdMicro === null
              ? t('departments.noBudget')
              : t('department.budget', { amount: money.format(d.budgetUsdMicro / 1_000_000) })}
          </p>
        </div>
      )}
    </WithDepartment>
  );
}

export function DepartmentUsers({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  return (
    <WithDepartment me={me} getToken={getToken} title={t('nav.department.users')}>
      {(d, base) => <People key={d.id} path={`${base}/users`} getToken={getToken} />}
    </WithDepartment>
  );
}

function People({ path, getToken }: { path: string; getToken: GetToken }) {
  const { t } = useTranslation();
  const people = useQuery({
    queryKey: ['department-users', path],
    queryFn: () => apiFetch<{ users: Person[] }>(path, getToken),
  });
  const rows = people.data?.users ?? [];
  if (people.isLoading) return <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>;
  if (people.isError) {
    return (
      <p className="mt-4 text-sm text-danger" role="alert">
        {t('errors.generic')}
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-muted">{t('department.noPeople')}</p>;
  }
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-left text-sm" data-testid="department-users">
        <thead className="border-b border-line text-muted">
          <tr>
            <th className="px-3 py-2 font-medium">{t('users.person')}</th>
            <th className="px-3 py-2 font-medium">{t('users.role')}</th>
            <th className="px-3 py-2 font-medium">{t('users.tier')}</th>
            <th className="px-3 py-2 font-medium">{t('users.statusLabel')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className="border-b border-line last:border-b-0">
              <td className="px-3 py-2">
                <div className="font-medium">{p.name}</div>
                <div className="break-all text-muted">{p.email}</div>
              </td>
              <td className="px-3 py-2">{t(`roles.${p.role}`, { defaultValue: p.role })}</td>
              <td className="px-3 py-2">{p.seatPlanCode}</td>
              <td className="px-3 py-2">
                {t(`users.status.${p.status}`, { defaultValue: p.status })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DepartmentUsage({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  return (
    <WithDepartment me={me} getToken={getToken} title={t('nav.department.usage')}>
      {(d, base) => (
        <UsageReport
          key={d.id}
          path={`${base}/usage`}
          groups={['user', 'model', 'day']}
          getToken={getToken}
        />
      )}
    </WithDepartment>
  );
}

export function DepartmentRequests({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  return (
    <WithDepartment me={me} getToken={getToken} title={t('nav.department.requests')}>
      {(d, base) => (
        <Requests key={d.id} path={`${base}/requests`} getToken={getToken} selfId={me.user?.id} />
      )}
    </WithDepartment>
  );
}

function Requests({
  path,
  getToken,
}: {
  path: string;
  getToken: GetToken;
  selfId: string | undefined;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const requests = useQuery({
    queryKey: ['department-requests', path],
    queryFn: () => apiFetch<{ requests: Request[] }>(path, getToken),
  });
  const [error, setError] = useState<string | null>(null);
  const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const decide = async (id: string, status: 'approved' | 'rejected') => {
    setError(null);
    try {
      await apiSend('PATCH', `${path}/${id}`, getToken, { status });
      await client.invalidateQueries({ queryKey: ['department-requests', path] });
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'generic';
      setError(t(`errors.${code}`, { defaultValue: t('errors.generic') }));
    }
  };

  const rows = requests.data?.requests ?? [];
  if (requests.isLoading) return <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>;
  if (requests.isError) {
    return (
      <p className="mt-4 text-sm text-danger" role="alert">
        {t('errors.generic')}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="mt-4 text-sm text-muted" data-testid="no-requests">
        {t('department.noRequests')}
      </p>
    );
  }
  return (
    <div>
      <p className="mt-2 text-sm text-muted">{t('department.requestsHelp')}</p>
      {error && (
        <p className="mt-3 text-sm text-danger" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
      <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
        {rows.map((r) => (
          <li
            key={r.id}
            className="p-3 text-sm"
            data-testid={`request-${r.userEmail}`}
            data-status={r.status}
          >
            <div className="font-medium">
              {t(`department.requestType.${r.type}`, { defaultValue: r.type })} · {r.userName}
            </div>
            <div className="text-muted">
              {r.userEmail} · {date.format(new Date(r.createdAt))}
            </div>
            {r.reason && <p className="mt-1 whitespace-pre-wrap">{r.reason}</p>}
            {r.status === 'pending' ? (
              <div className="mt-2 flex gap-2">
                <Button
                  variant="primary"
                  data-testid="approve"
                  onClick={() => void decide(r.id, 'approved')}
                >
                  {t('department.approve')}
                </Button>
                <Button data-testid="reject" onClick={() => void decide(r.id, 'rejected')}>
                  {t('department.reject')}
                </Button>
              </div>
            ) : (
              <p className="mt-1 text-muted" data-testid="decision">
                {t(`department.status.${r.status}`, { defaultValue: r.status })}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
