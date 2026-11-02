// SPDX-License-Identifier: AGPL-3.0-only
// A tenant admin's usage reports (LLD-04 §1.2, tracker P1-30).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch, apiFetchText, type GetToken, type Me } from './api';
import { Button } from './components/ui';

const GROUPS = ['user', 'dept', 'model', 'day'] as const;
type Group = (typeof GROUPS)[number];

interface UsageRow {
  key: string | null;
  label: string;
  standard: number;
  premium: number;
  total: number;
}
interface UsageReport {
  from: string;
  to: string;
  rows: UsageRow[];
}

const today = () => new Date().toISOString().slice(0, 10);
const FIELD = 'mt-1 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm';

/** Gives the browser a file made here. */
function saveFile(name: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function TenantUsage({ me, getToken }: { me: Me; getToken: GetToken }) {
  const { t, i18n } = useTranslation();
  const [group, setGroup] = useState<Group>('user');
  const [from, setFrom] = useState(`${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today());
  const [exportFailed, setExportFailed] = useState(false);
  const query = new URLSearchParams({ groupBy: group, from, to }).toString();
  const path = `/tenants/${me.tenant!.id}/usage`;
  const report = useQuery({
    queryKey: ['usage', path, query],
    queryFn: () => apiFetch<UsageReport>(`${path}?${query}`, getToken),
    retry: false,
  });
  const number = new Intl.NumberFormat(i18n.language);
  const rows = report.data?.rows ?? [];
  const sum = (pick: (r: UsageRow) => number) => rows.reduce((total, r) => total + pick(r), 0);
  const labelOf = (r: UsageRow) => (r.key === null ? t('usage.none') : r.label);

  const download = async () => {
    setExportFailed(false);
    try {
      saveFile(`usage-${from}-${to}.csv`, await apiFetchText(`${path}/export?${query}`, getToken));
    } catch {
      setExportFailed(true);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold">{t('nav.tenant.usage')}</h1>
      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4">
        <label className="text-sm font-medium">
          {t('usage.from')}
          <input
            type="date"
            data-testid="usage-from"
            className={FIELD}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          {t('usage.to')}
          <input
            type="date"
            data-testid="usage-to"
            className={FIELD}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label className="text-sm font-medium">
          {t('usage.groupBy')}
          <select
            data-testid="usage-group"
            className={FIELD}
            value={group}
            onChange={(e) => setGroup(e.target.value as Group)}
          >
            {GROUPS.map((g) => (
              <option key={g} value={g}>
                {t(`usage.group.${g}`)}
              </option>
            ))}
          </select>
        </label>
        <Button data-testid="usage-export" onClick={() => void download()}>
          {t('usage.export')}
        </Button>
      </div>
      {exportFailed && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {t('errors.generic')}
        </p>
      )}
      {report.isLoading && <p className="mt-4 text-sm text-muted">{t('app.loading')}</p>}
      {report.isError && (
        <p className="mt-4 text-sm text-danger" role="alert" data-testid="usage-error">
          {t('usage.badRange')}
        </p>
      )}
      {report.isSuccess && rows.length === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="usage-empty">
          {t('usage.empty')}
        </p>
      )}
      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-sm" data-testid="usage-table">
            <thead className="border-b border-line text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">{t(`usage.group.${group}`)}</th>
                <th className="px-3 py-2 text-right font-medium">{t('overview.standard')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('overview.premium')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('usage.total')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key ?? 'none'} className="border-b border-line">
                  <td className="px-3 py-2">{labelOf(r)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{number.format(r.standard)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{number.format(r.premium)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{number.format(r.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="font-medium">
              <tr data-testid="usage-total" data-total={sum((r) => r.total)}>
                <td className="px-3 py-2">{t('usage.total')}</td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {number.format(sum((r) => r.standard))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {number.format(sum((r) => r.premium))}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {number.format(sum((r) => r.total))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
