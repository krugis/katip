// SPDX-License-Identifier: AGPL-3.0-only
// Our margin per company and month (LLD-06 §6, tracker P1-47). Provider admins only: the API
// refuses anyone else, and a company never sees cost.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiFetch, apiFetchText, type GetToken } from './api';
import { Button } from './components/ui';
import { saveFile } from './usage-page';

interface Money {
  seats: number;
  addons: number;
  overage: number;
  total: number;
}
interface MarginRow {
  tenantId: string;
  slug: string;
  name: string;
  status: string;
  seats: number;
  requests: number;
  revenue: Money;
  cost: number;
  margin: number;
  marginPct: number | null;
  belowTarget: boolean;
}
interface ModelCost {
  modelId: string;
  label: string;
  class: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  sharePct: number;
}
export interface MarginReport {
  month: string;
  basis: 'list_price' | 'invoiced';
  targetPct: number;
  tenants: MarginRow[];
  total: Omit<MarginRow, 'tenantId' | 'slug' | 'name' | 'status' | 'belowTarget'>;
  models: ModelCost[];
}

const FIELD = 'mt-1 block rounded-md border border-line bg-surface px-2 py-1.5 text-sm';
const TH = 'px-3 py-2 font-medium';
const NUM = 'px-3 py-2 text-right tabular-nums';

function Tile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4" data-testid={testId}>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

export function ProviderMargin({ getToken }: { getToken: GetToken }) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [exportFailed, setExportFailed] = useState(false);
  const report = useQuery({
    queryKey: ['margin', month],
    queryFn: () => apiFetch<MarginReport>(`/admin/margin?month=${month}`, getToken),
    enabled: /^\d{4}-\d{2}$/.test(month),
    retry: false,
  });
  // Money is kept in micro-USD; shown in dollars.
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' });
  const money = (micro: number) => usd.format(micro / 1_000_000);
  const number = new Intl.NumberFormat(i18n.language);
  const pct = (p: number | null) =>
    p === null
      ? '–'
      : `${new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(p)}%`;
  const data = report.data;

  const download = async () => {
    setExportFailed(false);
    try {
      const lang = i18n.language.startsWith('en') ? 'en' : 'tr';
      saveFile(
        `margin-${month}.csv`,
        await apiFetchText(`/admin/margin/export?month=${month}&lang=${lang}`, getToken),
      );
    } catch {
      setExportFailed(true);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-semibold">{t('nav.provider.usage')}</h1>
      {(!data || data.basis === 'list_price') && (
        <p
          className="mt-4 max-w-3xl rounded-lg border border-line bg-accent-soft p-3 text-sm"
          data-testid="margin-basis"
        >
          {t('margin.listPriceNote')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4">
        <label className="text-sm font-medium">
          {t('margin.month')}
          <input
            type="month"
            data-testid="margin-month"
            className={FIELD}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </label>
        <Button data-testid="margin-export" onClick={() => void download()}>
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
        <p className="mt-4 text-sm text-danger" role="alert" data-testid="margin-error">
          {t('errors.generic')}
        </p>
      )}
      {data && data.tenants.length === 0 && (
        <p className="mt-4 text-sm text-muted" data-testid="margin-empty">
          {t('margin.empty')}
        </p>
      )}
      {data && data.tenants.length > 0 && (
        <>
          <div
            className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
            data-testid="margin-total"
            data-margin={data.total.margin}
          >
            <Tile
              testId="total-revenue"
              label={t('margin.revenue')}
              value={money(data.total.revenue.total)}
            />
            <Tile testId="total-cost" label={t('margin.cost')} value={money(data.total.cost)} />
            <Tile
              testId="total-margin"
              label={t('margin.margin')}
              value={money(data.total.margin)}
            />
            <Tile
              testId="total-pct"
              label={t('margin.marginPct')}
              value={pct(data.total.marginPct)}
            />
          </div>

          <h2 className="mt-6 text-sm font-medium text-muted">{t('margin.byCompany')}</h2>
          <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-left text-sm" data-testid="margin-table">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className={TH}>{t('tenants.name')}</th>
                  <th className={`${TH} text-right`}>{t('margin.seatCount')}</th>
                  <th className={`${TH} text-right`}>{t('margin.seatRevenue')}</th>
                  <th className={`${TH} text-right`}>{t('margin.addons')}</th>
                  <th className={`${TH} text-right`}>{t('margin.overage')}</th>
                  <th className={`${TH} text-right`}>{t('margin.revenue')}</th>
                  <th className={`${TH} text-right`}>{t('margin.cost')}</th>
                  <th className={`${TH} text-right`}>{t('margin.margin')}</th>
                  <th className={`${TH} text-right`}>{t('margin.marginPct')}</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((r) => (
                  <tr
                    key={r.tenantId}
                    className="border-b border-line align-top"
                    data-slug={r.slug}
                    data-below-target={r.belowTarget}
                  >
                    <td className="px-3 py-2">
                      <span className="block">{r.name || r.slug}</span>
                      <span className="font-mono text-xs text-muted">{r.slug}</span>
                      {r.status !== 'active' && (
                        <span className="ml-2 text-xs text-muted">
                          {t(`tenants.statusValue.${r.status}`, { defaultValue: r.status })}
                        </span>
                      )}
                    </td>
                    <td className={NUM}>{number.format(r.seats)}</td>
                    <td className={NUM}>{money(r.revenue.seats)}</td>
                    <td className={NUM}>{money(r.revenue.addons)}</td>
                    <td className={NUM}>{money(r.revenue.overage)}</td>
                    <td className={NUM}>{money(r.revenue.total)}</td>
                    <td className={NUM}>{money(r.cost)}</td>
                    <td className={`${NUM} ${r.margin < 0 ? 'text-danger' : ''}`}>
                      {money(r.margin)}
                    </td>
                    <td className={`${NUM} ${r.belowTarget ? 'font-medium text-danger' : ''}`}>
                      {pct(r.marginPct)}
                      {r.belowTarget && (
                        <span className="block text-xs" data-testid="below-target">
                          {t('margin.belowTarget', { pct: data.targetPct })}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="font-medium">
                <tr>
                  <td className="px-3 py-2">{t('margin.platform')}</td>
                  <td className={NUM}>{number.format(data.total.seats)}</td>
                  <td className={NUM}>{money(data.total.revenue.seats)}</td>
                  <td className={NUM}>{money(data.total.revenue.addons)}</td>
                  <td className={NUM}>{money(data.total.revenue.overage)}</td>
                  <td className={NUM}>{money(data.total.revenue.total)}</td>
                  <td className={NUM}>{money(data.total.cost)}</td>
                  <td className={NUM}>{money(data.total.margin)}</td>
                  <td className={NUM}>{pct(data.total.marginPct)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 max-w-3xl text-xs text-muted">{t('margin.notIncluded')}</p>

          <h2 className="mt-6 text-sm font-medium text-muted">{t('margin.byModel')}</h2>
          {data.models.length === 0 ? (
            <p className="mt-2 text-sm text-muted" data-testid="margin-no-models">
              {t('margin.noModels')}
            </p>
          ) : (
            <div className="mt-2 overflow-x-auto rounded-lg border border-line bg-surface">
              <table className="w-full text-left text-sm" data-testid="margin-models">
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th className={TH}>{t('usage.group.model')}</th>
                    <th className={TH}>{t('margin.class')}</th>
                    <th className={`${TH} text-right`}>{t('margin.requests')}</th>
                    <th className={`${TH} text-right`}>{t('margin.tokens')}</th>
                    <th className={`${TH} text-right`}>{t('margin.cost')}</th>
                    <th className={TH}>{t('margin.share')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.models.map((m) => (
                    <tr
                      key={m.modelId}
                      className="border-b border-line last:border-b-0"
                      data-model={m.modelId}
                    >
                      <td className="px-3 py-2">
                        <span className="block">{m.label}</span>
                        <span className="font-mono text-xs text-muted">{m.modelId}</span>
                      </td>
                      <td className="px-3 py-2">
                        {t(`margin.modelClass.${m.class}`, { defaultValue: m.class })}
                      </td>
                      <td className={NUM}>{number.format(m.requests)}</td>
                      <td className={NUM}>{number.format(m.inputTokens + m.outputTokens)}</td>
                      <td className={NUM}>{money(m.cost)}</td>
                      <td className="px-3 py-2">
                        <span className="flex items-center gap-2">
                          <progress
                            className="h-2 w-24"
                            max={100}
                            value={m.sharePct}
                            aria-label={m.label}
                          />
                          <span className="tabular-nums">{pct(m.sharePct)}</span>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
