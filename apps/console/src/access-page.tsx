// SPDX-License-Identifier: AGPL-3.0-only
// A tenant admin's access rules (LLD-02 §6, tracker P1-28).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetch, apiSend, type GetToken, type Me } from './api';
import { Button } from './components/ui';

interface AccessRules {
  ipAllowlist: string[];
  countries: string[];
  mfaRequired: boolean;
  sessionIdleMin: number;
  sessionMaxH: number;
  callerIp: string;
}

const FIELD = 'mt-1 w-full max-w-md rounded-md border border-line bg-surface px-2 py-1.5 text-sm';
const SECTION = 'rounded-lg border border-line bg-surface p-4';
const TITLE = 'block text-sm font-medium';
const HELP = 'mt-1 text-sm text-muted';
const lines = (text: FormDataEntryValue | null) =>
  String(text ?? '')
    .split(/[\s,]+/)
    .filter(Boolean);

export function TenantAccessRules({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const path = `/tenants/${me.tenant!.id}/access-rules`;
  const rules = useQuery({
    queryKey: ['access', path],
    queryFn: () => apiFetch<AccessRules>(path, getToken),
  });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async (body: object) => {
    setSaving(true);
    try {
      const result = await apiSend<AccessRules>('PUT', path, getToken, body);
      client.setQueryData(['access', path], result);
      setSaved(true);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      if (code === 'would_lock_out' && window.confirm(t('access.confirmLockOut'))) {
        await save({ ...body, force: true });
        return;
      }
      if (code !== 'would_lock_out') {
        setError(t(`errors.${code}`, { defaultValue: t('errors.generic') }));
      }
    } finally {
      setSaving(false);
    }
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    setError(null);
    setSaved(false);
    void save({
      ipAllowlist: lines(data.get('ipAllowlist')),
      countries: lines(data.get('countries')),
      sessionIdleMin: Number(data.get('sessionIdleMin')),
      sessionMaxH: Number(data.get('sessionMaxH')),
    });
  };

  if (rules.isLoading) return <p className="text-sm text-muted">{t('app.loading')}</p>;
  if (!rules.data) {
    return (
      <p className="text-sm text-danger" role="alert">
        {t('errors.generic')}
      </p>
    );
  }
  const current = rules.data;

  return (
    <form onSubmit={submit} data-testid="access-form" className="max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold">{t('nav.tenant.access')}</h1>

      <section className={SECTION}>
        <label className={TITLE}>
          {t('access.ipAllowlist')}
          <textarea
            name="ipAllowlist"
            rows={4}
            data-testid="ip-allowlist"
            className={`${FIELD} font-mono`}
            defaultValue={current.ipAllowlist.join('\n')}
          />
        </label>
        <p className={HELP}>{t('access.ipHelp')}</p>
        <p className={HELP}>
          {t('access.yourAddress')}{' '}
          <span className="font-mono" data-testid="caller-ip">
            {current.callerIp}
          </span>
        </p>
      </section>

      <section className={SECTION}>
        <label className={TITLE}>
          {t('access.countries')}
          <textarea
            name="countries"
            rows={2}
            data-testid="countries"
            className={`${FIELD} font-mono`}
            defaultValue={current.countries.join(' ')}
          />
        </label>
        <p className={HELP}>{t('access.countriesHelp')}</p>
      </section>

      <section className={`${SECTION} grid gap-3 sm:grid-cols-2`}>
        <label className={TITLE}>
          {t('access.idle')}
          <input
            name="sessionIdleMin"
            type="number"
            min="5"
            max="30"
            required
            data-testid="session-idle"
            className={FIELD}
            defaultValue={Math.min(current.sessionIdleMin, 30)}
          />
        </label>
        <label className={TITLE}>
          {t('access.max')}
          <input
            name="sessionMaxH"
            type="number"
            min="1"
            max="10"
            required
            data-testid="session-max"
            className={FIELD}
            defaultValue={Math.min(current.sessionMaxH, 10)}
          />
        </label>
      </section>

      <section className={SECTION}>
        <p className={TITLE}>{t('access.mfa')}</p>
        <p className={HELP} data-testid="mfa-note">
          {t('access.mfaHelp')}
        </p>
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" data-testid="access-save" disabled={saving}>
          {t('access.save')}
        </Button>
        {saved && (
          <p className="text-sm text-muted" role="status" data-testid="access-saved">
            {t('access.saved')}
          </p>
        )}
      </div>
      {error && (
        <p className="text-sm text-danger" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
    </form>
  );
}
