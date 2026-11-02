// SPDX-License-Identifier: AGPL-3.0-only
// A tenant admin's models and policies (LLD-04 §1.2, tracker P1-27).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiFetch, apiSend, type GetToken, type Me } from './api';
import { Button } from './components/ui';

interface Policy {
  aliases: Record<'auto' | 'fast' | 'best' | 'tr-local', boolean>;
  allowUserModelChoice: boolean;
  allowedModels: string[];
  atQuotaLimit: 'block' | 'downgrade' | 'overage';
  residency: 'ANY_APPROVED' | 'EU_ONLY' | 'TR_ONLY';
  pii: {
    mode: 'off' | 'mask' | 'block';
    entities?: Record<string, string>;
    onDetectorFailure?: 'allow' | 'block';
  };
}
interface PolicyResponse {
  policy: Policy;
  version: number;
  kvkkAddon: boolean;
  catalog: { id: string; displayName: string; class: string; region: string; dataPolicy: string }[];
}

const SELECT =
  'mt-1 w-full max-w-sm rounded-md border border-line bg-surface px-2 py-1.5 text-sm disabled:opacity-60';
const SECTION = 'rounded-lg border border-line bg-surface p-4';
const TITLE = 'block text-sm font-medium';
const HELP = 'mt-1 text-sm text-muted';

function Check({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  testId: string;
}) {
  return (
    <label className="mt-2 flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        data-testid={testId}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function TenantPolicies({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const path = `/tenants/${me.tenant!.id}/policy`;
  const loaded = useQuery({
    queryKey: ['policy', path],
    queryFn: () => apiFetch<PolicyResponse>(path, getToken),
  });
  const [draft, setDraft] = useState<Policy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (loaded.data) setDraft(loaded.data.policy);
  }, [loaded.data]);

  if (loaded.isLoading || (loaded.data && !draft)) {
    return <p className="text-sm text-muted">{t('app.loading')}</p>;
  }
  if (!loaded.data || !draft) {
    return (
      <p className="text-sm text-danger" role="alert">
        {t('errors.generic')}
      </p>
    );
  }
  const { kvkkAddon, catalog, version } = loaded.data;
  const change = (next: Partial<Policy>) => {
    setSaved(false);
    setDraft({ ...draft, ...next });
  };
  const allModels = draft.allowedModels.length === 0;
  const toggleModel = (id: string, on: boolean) =>
    change({
      allowedModels: on
        ? [...draft.allowedModels, id]
        : draft.allowedModels.filter((m) => m !== id),
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (
      draft.pii.mode === 'off' &&
      loaded.data?.policy.pii.mode !== 'off' &&
      !window.confirm(t('policy.confirmPiiOff'))
    ) {
      return;
    }
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const result = await apiSend<PolicyResponse>('PUT', path, getToken, {
        policy: draft,
        version,
      });
      client.setQueryData(['policy', path], result);
      setSaved(true);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'generic';
      setError(t(`errors.${code}`, { defaultValue: t('errors.generic') }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void submit(e)}
      data-testid="policy-form"
      className="max-w-3xl space-y-4"
    >
      <h1 className="text-xl font-semibold">{t('nav.tenant.policies')}</h1>

      <section className={SECTION}>
        <h2 className={TITLE}>{t('policy.aliases')}</h2>
        <p className={HELP}>{t('policy.aliasesHelp')}</p>
        {(['auto', 'fast', 'best'] as const).map((alias) => (
          <Check
            key={alias}
            testId={`alias-${alias}`}
            label={t(`policy.alias.${alias}`)}
            checked={draft.aliases[alias]}
            onChange={(on) => change({ aliases: { ...draft.aliases, [alias]: on } })}
          />
        ))}
        {kvkkAddon && (
          <Check
            testId="alias-tr-local"
            label={t('policy.alias.trLocal')}
            checked={draft.aliases['tr-local']}
            onChange={(on) => change({ aliases: { ...draft.aliases, 'tr-local': on } })}
          />
        )}
        <Check
          testId="user-choice"
          label={t('policy.userChoice')}
          checked={draft.allowUserModelChoice}
          onChange={(on) => change({ allowUserModelChoice: on })}
        />
      </section>

      <section className={SECTION}>
        <h2 className={TITLE}>{t('policy.models')}</h2>
        <p className={HELP}>{t(allModels ? 'policy.modelsAll' : 'policy.modelsSome')}</p>
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {catalog.map((m) => (
            <li key={m.id}>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  data-testid={`model-${m.id}`}
                  checked={draft.allowedModels.includes(m.id)}
                  onChange={(e) => toggleModel(m.id, e.target.checked)}
                />
                <span>
                  {m.displayName}
                  <span className="block text-muted">
                    {t(`policy.class.${m.class}`, { defaultValue: m.class })} · {m.region}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className={SECTION}>
        <label className={TITLE} htmlFor="at-limit">
          {t('policy.atLimit')}
        </label>
        <select
          id="at-limit"
          data-testid="at-limit"
          className={SELECT}
          value={draft.atQuotaLimit}
          onChange={(e) => change({ atQuotaLimit: e.target.value as Policy['atQuotaLimit'] })}
        >
          {(['downgrade', 'block', 'overage'] as const).map((b) => (
            <option key={b} value={b}>
              {t(`policy.limit.${b}`)}
            </option>
          ))}
        </select>
      </section>

      <section className={SECTION}>
        <label className={TITLE} htmlFor="pii-mode">
          {t('policy.pii')}
        </label>
        <select
          id="pii-mode"
          data-testid="pii-mode"
          className={SELECT}
          value={draft.pii.mode}
          onChange={(e) =>
            change({ pii: { ...draft.pii, mode: e.target.value as Policy['pii']['mode'] } })
          }
        >
          {(['mask', 'block', 'off'] as const).map((m) => (
            <option key={m} value={m}>
              {t(`policy.piiMode.${m}`)}
            </option>
          ))}
        </select>
        {draft.pii.mode === 'off' && (
          <p className="mt-2 text-sm text-danger" data-testid="pii-off-warning">
            {t('policy.piiOffWarning')}
          </p>
        )}
        <Check
          testId="detector-block"
          label={t('policy.detectorBlock')}
          checked={draft.pii.onDetectorFailure === 'block'}
          onChange={(on) =>
            change({ pii: { ...draft.pii, onDetectorFailure: on ? 'block' : 'allow' } })
          }
        />
      </section>

      <section className={SECTION}>
        <label className={TITLE} htmlFor="residency">
          {t('policy.residency')}
        </label>
        <select
          id="residency"
          data-testid="residency"
          className={SELECT}
          disabled={!kvkkAddon}
          value={draft.residency}
          onChange={(e) => change({ residency: e.target.value as Policy['residency'] })}
        >
          {(['ANY_APPROVED', 'EU_ONLY', 'TR_ONLY'] as const).map((r) => (
            <option key={r} value={r}>
              {t(`policy.residencyValue.${r}`)}
            </option>
          ))}
        </select>
        {!kvkkAddon && <p className={HELP}>{t('policy.residencyAddon')}</p>}
      </section>

      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" data-testid="policy-save" disabled={saving}>
          {t('policy.save')}
        </Button>
        {saved && (
          <p className="text-sm text-muted" role="status" data-testid="policy-saved">
            {t('policy.saved')}
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
