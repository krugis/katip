// SPDX-License-Identifier: AGPL-3.0-only
// A tenant admin's screens (LLD-04 §1.2, tracker P1-26).
import { useCreate, useList, useUpdate } from '@refinedev/core';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetch, apiSend, type GetToken, type Me } from './api';
import { Button } from './components/ui';

interface SeatRow {
  planCode: string;
  quantity: number;
  used: number;
}
interface Overview {
  month: string;
  seats: SeatRow[];
  limits: { standard: number; premium: number; research: number } | null;
  used: { standard: number; premium: number; research: number };
}
interface UserRow {
  [key: string]: unknown;
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  departmentId: string | null;
  seatPlanCode: string | null;
}
interface DepartmentRow {
  [key: string]: unknown;
  id: string;
  name: string;
  budgetUsdMicro: number | null;
  managerIds: string[];
  userCount: number;
}
interface ImportJob {
  status: 'running' | 'done' | 'failed' | 'interrupted';
  total: number;
  created: number;
  skipped: number;
  notInvited: number;
  failed: { row: number; reason: string }[];
}

const ROLES = ['user', 'dept_manager', 'tenant_admin'];
const WARN_AT = 0.8;
const INPUT = 'w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm';
const LABEL = 'block text-sm font-medium';

function useProblemText() {
  const { t } = useTranslation();
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : (e as { code?: string } | null)?.code;
    return t(`errors.${code}`, { defaultValue: t('errors.generic') });
  };
}

function Alert({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-2 text-sm text-danger" role="alert" data-testid="form-error">
      {children}
    </p>
  );
}

const useOverview = (tenantId: string, getToken: GetToken) =>
  useQuery({
    queryKey: ['overview', tenantId],
    queryFn: () => apiFetch<Overview>(`/tenants/${tenantId}/overview`, getToken),
  });

// ---- overview -----------------------------------------------------------------------------

function Meter({
  label,
  used,
  limit,
  testId,
}: {
  label: string;
  used: number;
  limit: number;
  testId: string;
}) {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const near = limit > 0 && used / limit >= WARN_AT;
  return (
    <div className="rounded-lg border border-line bg-surface p-4" data-testid={testId}>
      <p className="text-sm font-medium">{label}</p>
      <p className="mt-1 text-sm text-muted">
        {t('overview.usedOf', { used: number.format(used), limit: number.format(limit) })}
      </p>
      <progress className="mt-2 h-2 w-full" max={limit || 1} value={used} aria-label={label} />
      {near && <p className="mt-2 text-sm text-danger">{t('overview.nearLimit')}</p>}
    </div>
  );
}

export function TenantOverview({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  const overview = useOverview(me.tenant!.id, getToken);
  return (
    <div>
      <h1 className="text-xl font-semibold">{t('nav.tenant.overview')}</h1>
      {overview.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {overview.isError && <Alert>{t('errors.generic')}</Alert>}
      {overview.data && (
        <>
          <h2 className="mt-6 text-sm font-medium text-muted">{t('overview.seats')}</h2>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {overview.data.seats.map((s) => (
              <Meter
                key={s.planCode}
                testId={`seats-${s.planCode}`}
                label={s.planCode}
                used={s.used}
                limit={s.quantity}
              />
            ))}
          </div>
          <h2 className="mt-6 text-sm font-medium text-muted">{t('overview.quota')}</h2>
          {overview.data.limits ? (
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Meter
                testId="quota-standard"
                label={t('overview.standard')}
                used={overview.data.used.standard}
                limit={overview.data.limits.standard}
              />
              <Meter
                testId="quota-premium"
                label={t('overview.premium')}
                used={overview.data.used.premium}
                limit={overview.data.limits.premium}
              />
              <Meter
                testId="quota-research"
                label={t('overview.research')}
                used={overview.data.used.research}
                limit={overview.data.limits.research}
              />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">{t('overview.noLimits')}</p>
          )}
        </>
      )}
    </div>
  );
}

// ---- users --------------------------------------------------------------------------------

function InviteForm({
  resource,
  departments,
  plans,
}: {
  resource: string;
  departments: DepartmentRow[];
  plans: string[];
}) {
  const { t } = useTranslation();
  const problemText = useProblemText();
  const { mutate, mutation } = useCreate();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError(null);
    setNotice(null);
    mutate(
      {
        resource,
        values: {
          email: String(data.get('email')).trim(),
          name: String(data.get('name')).trim(),
          role: data.get('role'),
          departmentId: data.get('departmentId') || null,
          seatPlanCode: data.get('seatPlanCode') || null,
        },
      },
      {
        onSuccess: (res) => {
          const invited = (res.data as { invited?: boolean }).invited;
          setNotice(t(invited ? 'users.invited' : 'users.invitedNoEmail'));
          form.reset();
        },
        onError: (err) => setError(problemText(err)),
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      data-testid="invite-form"
      className="mt-4 grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      <label className={LABEL}>
        {t('users.email')}
        <input name="email" type="email" required autoComplete="off" className={`mt-1 ${INPUT}`} />
      </label>
      <label className={LABEL}>
        {t('users.name')}
        <input name="name" required autoComplete="off" className={`mt-1 ${INPUT}`} />
      </label>
      <label className={LABEL}>
        {t('users.role')}
        <select name="role" className={`mt-1 ${INPUT}`} defaultValue="user">
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`)}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        {t('users.department')}
        <select name="departmentId" className={`mt-1 ${INPUT}`} defaultValue="">
          <option value="">{t('users.noDepartment')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        {t('users.tier')}
        <select name="seatPlanCode" className={`mt-1 ${INPUT}`}>
          {plans.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <Button
          variant="primary"
          type="submit"
          data-testid="invite-submit"
          disabled={mutation.isPending}
        >
          {t('users.sendInvite')}
        </Button>
      </div>
      <div className="sm:col-span-2 lg:col-span-3">
        {error && <Alert>{error}</Alert>}
        {notice && (
          <p className="text-sm text-muted" role="status" data-testid="invite-notice">
            {notice}
          </p>
        )}
      </div>
    </form>
  );
}

function CsvImport({
  tenantId,
  getToken,
  onFinished,
}: {
  tenantId: string;
  getToken: GetToken;
  onFinished: () => void;
}) {
  const { t } = useTranslation();
  const problemText = useProblemText();
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const job = useQuery({
    queryKey: ['import', jobId],
    enabled: jobId !== null,
    queryFn: async () => {
      const result = await apiFetch<ImportJob>(
        `/tenants/${tenantId}/users/imports/${jobId}`,
        getToken,
      );
      if (result.status !== 'running') onFinished();
      return result;
    },
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setJobId(null);
    try {
      const started = await apiSend<{ id: string }>(
        'POST',
        `/tenants/${tenantId}/users/import`,
        getToken,
        await file.text(),
        'text/csv',
      );
      setJobId(started.id);
    } catch (e) {
      setError(problemText(e));
    }
  };

  const result = job.data;
  return (
    <div className="mt-4 rounded-lg border border-line bg-surface p-4">
      <label className={LABEL}>
        {t('users.importLabel')}
        <input
          type="file"
          accept=".csv,text/csv"
          data-testid="import-file"
          className="mt-1 block text-sm"
          onChange={(e) => {
            void upload(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      <p className="mt-1 text-sm text-muted">{t('users.importHelp')}</p>
      {error && <Alert>{error}</Alert>}
      {result && (
        <div
          className="mt-3 text-sm"
          role="status"
          data-testid="import-result"
          data-status={result.status}
        >
          <p>
            {t(`users.importStatus.${result.status}`, {
              done: result.created + result.skipped + result.failed.length,
              total: result.total,
            })}
          </p>
          <p className="text-muted">
            {t('users.importCounts', {
              created: result.created,
              skipped: result.skipped,
              failed: result.failed.length,
            })}
          </p>
          {result.notInvited > 0 && (
            <p className="text-danger">
              {t('users.importNotInvited', { count: result.notInvited })}
            </p>
          )}
          {result.failed.length > 0 && (
            <ul className="mt-2 list-inside list-disc text-muted">
              {result.failed.slice(0, 50).map((f) => (
                <li key={f.row}>
                  {t('users.importRow', { row: f.row })}:{' '}
                  {t(`errors.${f.reason}`, { defaultValue: t('errors.generic') })}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function UserTableRow({
  user,
  isSelf,
  resource,
  departments,
  plans,
  tenantId,
  getToken,
}: {
  user: UserRow;
  isSelf: boolean;
  resource: string;
  departments: DepartmentRow[];
  plans: string[];
  tenantId: string;
  getToken: GetToken;
}) {
  const { t } = useTranslation();
  const problemText = useProblemText();
  const { mutate, mutation } = useUpdate();
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const change = (values: Record<string, unknown>) => {
    setError(null);
    mutate({ resource, id: user.id, values }, { onError: (e) => setError(problemText(e)) });
  };
  const resend = async () => {
    setError(null);
    setResent(false);
    try {
      await apiSend('POST', `/tenants/${tenantId}/users/${user.id}/invite`, getToken);
      setResent(true);
    } catch (e) {
      setError(problemText(e));
    }
  };
  const disable = () => {
    if (window.confirm(t('users.confirmDisable', { email: user.email }))) {
      change({ status: 'disabled' });
    }
  };
  const active = user.status === 'active';
  const select = 'rounded-md border border-line bg-surface px-1.5 py-1 text-sm disabled:opacity-60';

  return (
    <tr
      className="border-b border-line align-top last:border-b-0"
      data-testid={`user-${user.email}`}
    >
      <td className="px-3 py-2">
        <div className="font-medium">{user.name}</div>
        <div className="break-all text-muted">{user.email}</div>
        {error && <Alert>{error}</Alert>}
        {resent && (
          <p className="mt-1 text-muted" role="status">
            {t('users.resent')}
          </p>
        )}
      </td>
      <td className="px-3 py-2">
        <select
          aria-label={t('users.role')}
          data-testid="role"
          className={select}
          disabled={isSelf || mutation.isPending}
          value={user.role}
          onChange={(e) => change({ role: e.target.value })}
        >
          {[...new Set([...ROLES, user.role])].map((r) => (
            <option key={r} value={r}>
              {t(`roles.${r}`, { defaultValue: r })}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          aria-label={t('users.department')}
          data-testid="department"
          className={select}
          disabled={mutation.isPending}
          value={user.departmentId ?? ''}
          onChange={(e) => change({ departmentId: e.target.value || null })}
        >
          <option value="">{t('users.noDepartment')}</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2">
        <select
          aria-label={t('users.tier')}
          data-testid="tier"
          className={select}
          disabled={mutation.isPending}
          value={user.seatPlanCode ?? ''}
          onChange={(e) => change({ seatPlanCode: e.target.value })}
        >
          {[...new Set([...plans, user.seatPlanCode ?? ''])].filter(Boolean).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </td>
      <td className="px-3 py-2" data-testid="status" data-status={user.status}>
        {t(`users.status.${user.status}`, { defaultValue: user.status })}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-1">
          {active && (
            <Button data-testid="resend" onClick={() => void resend()}>
              {t('users.resend')}
            </Button>
          )}
          {!isSelf &&
            (active ? (
              <Button data-testid="disable" onClick={disable} disabled={mutation.isPending}>
                {t('users.disable')}
              </Button>
            ) : (
              <Button
                data-testid="enable"
                onClick={() => change({ status: 'active' })}
                disabled={mutation.isPending}
              >
                {t('users.enable')}
              </Button>
            ))}
        </div>
      </td>
    </tr>
  );
}

export function TenantUsers({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  const tenantId = me.tenant!.id;
  const resource = `tenants/${tenantId}/users`;
  const users = useList<UserRow>({ resource, pagination: { mode: 'off' } });
  const departments = useList<DepartmentRow>({
    resource: `tenants/${tenantId}/departments`,
    pagination: { mode: 'off' },
  });
  const overview = useOverview(tenantId, getToken);
  const plans = overview.data?.seats.map((s) => s.planCode) ?? [];
  const [panel, setPanel] = useState<'invite' | 'import' | null>(null);
  const departmentRows = departments.result.data ?? [];
  const userRows = users.result.data ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t('nav.tenant.users')}</h1>
        <div className="flex gap-2">
          <Button
            variant="primary"
            data-testid="open-invite"
            aria-expanded={panel === 'invite'}
            onClick={() => setPanel(panel === 'invite' ? null : 'invite')}
          >
            {t('users.invite')}
          </Button>
          <Button
            data-testid="open-import"
            aria-expanded={panel === 'import'}
            onClick={() => setPanel(panel === 'import' ? null : 'import')}
          >
            {t('users.import')}
          </Button>
        </div>
      </div>
      {panel === 'invite' && (
        <InviteForm resource={resource} departments={departmentRows} plans={plans} />
      )}
      {panel === 'import' && (
        <CsvImport
          tenantId={tenantId}
          getToken={getToken}
          onFinished={() => void users.query.refetch()}
        />
      )}
      {users.query.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {users.query.isError && <Alert>{t('errors.generic')}</Alert>}
      {users.query.isSuccess && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm" data-testid="users-table">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t('users.person')}</th>
                <th className="px-3 py-2 font-medium">{t('users.role')}</th>
                <th className="px-3 py-2 font-medium">{t('users.department')}</th>
                <th className="px-3 py-2 font-medium">{t('users.tier')}</th>
                <th className="px-3 py-2 font-medium">{t('users.statusLabel')}</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">{t('users.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {userRows.map((u) => (
                <UserTableRow
                  key={u.id}
                  user={u}
                  isSelf={u.id === me.user?.id}
                  resource={resource}
                  departments={departmentRows}
                  plans={plans}
                  tenantId={tenantId}
                  getToken={getToken}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---- departments --------------------------------------------------------------------------

const toMicro = (usd: FormDataEntryValue | null): number | null => {
  const text = String(usd ?? '').trim();
  return text === '' ? null : Math.round(Number(text) * 1_000_000);
};

function DepartmentEditor({
  department,
  managers,
  resource,
  onClose,
}: {
  department: DepartmentRow;
  managers: UserRow[];
  resource: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const problemText = useProblemText();
  const { mutate, mutation } = useUpdate();
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(null);
    mutate(
      {
        resource,
        id: department.id,
        values: {
          name: String(data.get('name')).trim(),
          budgetUsdMicro: toMicro(data.get('budget')),
          managerIds: data.getAll('managerIds'),
        },
      },
      { onSuccess: onClose, onError: (err) => setError(problemText(err)) },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="grid gap-3 p-3 sm:grid-cols-2"
      data-testid="department-editor"
    >
      <label className={LABEL}>
        {t('departments.name')}
        <input name="name" required defaultValue={department.name} className={`mt-1 ${INPUT}`} />
      </label>
      <label className={LABEL}>
        {t('departments.budget')}
        <input
          name="budget"
          type="number"
          min="0"
          step="0.01"
          defaultValue={
            department.budgetUsdMicro === null ? '' : department.budgetUsdMicro / 1_000_000
          }
          className={`mt-1 ${INPUT}`}
        />
      </label>
      <fieldset className="sm:col-span-2">
        <legend className="text-sm font-medium">{t('departments.managers')}</legend>
        {managers.length === 0 && (
          <p className="mt-1 text-sm text-muted">{t('departments.noManagers')}</p>
        )}
        {managers.map((m) => (
          <label key={m.id} className="mt-1 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="managerIds"
              value={m.id}
              defaultChecked={department.managerIds.includes(m.id)}
              data-testid={`manager-${m.email}`}
            />
            {m.name} ({m.email})
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2 sm:col-span-2">
        <Button
          variant="primary"
          type="submit"
          data-testid="department-save"
          disabled={mutation.isPending}
        >
          {t('departments.save')}
        </Button>
        <Button onClick={onClose}>{t('departments.cancel')}</Button>
      </div>
      {error && <Alert>{error}</Alert>}
    </form>
  );
}

export function TenantDepartments({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const problemText = useProblemText();
  const tenantId = me.tenant!.id;
  const resource = `tenants/${tenantId}/departments`;
  const departments = useList<DepartmentRow>({ resource, pagination: { mode: 'off' } });
  const users = useList<UserRow>({
    resource: `tenants/${tenantId}/users`,
    pagination: { mode: 'off' },
  });
  const { mutate, mutation } = useCreate();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const rows = departments.result.data ?? [];
  const managers = (users.result.data ?? []).filter(
    (u) => u.role === 'dept_manager' && u.status === 'active',
  );
  const nameOf = (id: string) => (users.result.data ?? []).find((u) => u.id === id)?.name ?? id;
  const money = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' });

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError(null);
    mutate(
      {
        resource,
        values: {
          name: String(data.get('name')).trim(),
          budgetUsdMicro: toMicro(data.get('budget')),
        },
      },
      { onSuccess: () => form.reset(), onError: (err) => setError(problemText(err)) },
    );
  };

  return (
    <div>
      <h1 className="text-xl font-semibold">{t('nav.tenant.departments')}</h1>
      <form
        onSubmit={create}
        data-testid="department-form"
        className="mt-4 grid gap-3 rounded-lg border border-line bg-surface p-4 sm:grid-cols-[1fr_12rem_auto]"
      >
        <label className={LABEL}>
          {t('departments.name')}
          <input name="name" required className={`mt-1 ${INPUT}`} />
        </label>
        <label className={LABEL}>
          {t('departments.budget')}
          <input name="budget" type="number" min="0" step="0.01" className={`mt-1 ${INPUT}`} />
        </label>
        <div className="flex items-end">
          <Button
            variant="primary"
            type="submit"
            data-testid="department-create"
            disabled={mutation.isPending}
          >
            {t('departments.create')}
          </Button>
        </div>
        {error && (
          <div className="sm:col-span-3">
            <Alert>{error}</Alert>
          </div>
        )}
      </form>
      {departments.query.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {departments.query.isError && <Alert>{t('errors.generic')}</Alert>}
      {departments.query.isSuccess && rows.length === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="departments-empty">
          {t('departments.empty')}
        </p>
      )}
      {rows.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-surface">
          {rows.map((d) => (
            <li key={d.id} data-testid={`department-${d.name}`}>
              {editing === d.id ? (
                <DepartmentEditor
                  department={d}
                  managers={managers}
                  resource={resource}
                  onClose={() => setEditing(null)}
                />
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                  <div>
                    <div className="font-medium">{d.name}</div>
                    <div className="text-muted">
                      {t('departments.people', { count: d.userCount })} ·{' '}
                      {d.budgetUsdMicro === null
                        ? t('departments.noBudget')
                        : money.format(d.budgetUsdMicro / 1_000_000)}
                    </div>
                    <div className="text-muted" data-testid="department-managers">
                      {d.managerIds.length > 0
                        ? d.managerIds.map(nameOf).join(', ')
                        : t('departments.noManagerYet')}
                    </div>
                  </div>
                  <Button data-testid="department-edit" onClick={() => setEditing(d.id)}>
                    {t('departments.edit')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
