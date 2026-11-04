// SPDX-License-Identifier: AGPL-3.0-only
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from './api';
import i18n from './i18n';
import { ProviderMargin, type MarginReport } from './margin-page';

const money = (seats: number, addons: number, overage: number) => ({
  seats,
  addons,
  overage,
  total: seats + addons + overage,
});

const report: MarginReport = {
  month: '2026-03',
  basis: 'list_price',
  targetPct: 30,
  tenants: [
    {
      tenantId: 'a',
      slug: 'alfa',
      name: 'Alfa A.Ş.',
      status: 'active',
      seats: 3,
      requests: 3,
      revenue: money(28_800_000, 25_200_000, 600_000),
      cost: 501_244,
      margin: 54_098_756,
      marginPct: 99.1,
      belowTarget: false,
    },
    {
      tenantId: 'g',
      slug: 'gone',
      name: 'Gone Ltd.',
      status: 'deleted',
      seats: 1,
      requests: 1,
      revenue: money(14_000_000, 0, 0),
      cost: 12_000_000,
      margin: 2_000_000,
      marginPct: 14.3,
      belowTarget: true,
    },
  ],
  total: {
    seats: 4,
    requests: 4,
    revenue: money(42_800_000, 25_200_000, 600_000),
    cost: 12_501_244,
    margin: 56_098_756,
    marginPct: 81.8,
  },
  models: [
    {
      modelId: 'std-glm-5.3-flash',
      label: 'GLM-5.3 Flash',
      class: 'standard',
      requests: 1,
      inputTokens: 10,
      outputTokens: 5,
      cost: 12_000_000,
      sharePct: 96,
    },
    {
      modelId: 'emb-bge-m3',
      label: 'BGE-M3 embeddings',
      class: 'embedding',
      requests: 1,
      inputTokens: 10,
      outputTokens: 0,
      cost: 10,
      sharePct: 0,
    },
  ],
};

const empty: MarginReport = {
  ...report,
  tenants: [],
  models: [],
  total: { seats: 0, requests: 0, revenue: money(0, 0, 0), cost: 0, margin: 0, marginPct: null },
};

const show = (answer: MarginReport) => {
  const fetch = vi.spyOn(api, 'apiFetch').mockResolvedValue(answer as never);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ProviderMargin getToken={async () => 'token'} />
    </QueryClientProvider>,
  );
  return fetch;
};

beforeEach(async () => {
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the margin screen', () => {
  it('shows each company in dollars, with the platform total', async () => {
    show(report);
    const table = await screen.findByTestId('margin-table');
    const alfa = table.querySelector('tr[data-slug=alfa]')!;
    expect(alfa.textContent).toContain('Alfa A.Ş.');
    expect(alfa.textContent).toContain('$28.80');
    expect(alfa.textContent).toContain('$25.20');
    expect(alfa.textContent).toContain('$0.60');
    expect(alfa.textContent).toContain('$54.60');
    expect(alfa.textContent).toContain('$0.50');
    expect(alfa.textContent).toContain('$54.10');
    expect(alfa.textContent).toContain('99.1%');
    expect(screen.getByTestId('total-revenue').textContent).toContain('$68.60');
    expect(screen.getByTestId('total-cost').textContent).toContain('$12.50');
    expect(screen.getByTestId('total-pct').textContent).toContain('81.8%');
    expect(table.querySelector('tfoot')!.textContent).toContain('Platform total');
  });

  it('flags a company under the target, and names a deleted one', async () => {
    show(report);
    const gone = (await screen.findByTestId('margin-table')).querySelector('tr[data-slug=gone]')!;
    expect(gone.getAttribute('data-below-target')).toBe('true');
    expect(gone.textContent).toContain('under 30%');
    expect(gone.textContent).toContain('Deleted');
  });

  it('says plainly that this is list price, not invoiced revenue', async () => {
    show(report);
    await screen.findByTestId('margin-table');
    expect(screen.getByTestId('margin-basis').textContent).toContain('list price');
    expect(screen.getByTestId('margin-basis').textContent).toContain("isn't what was invoiced");
  });

  it('lists the cost by model, the most expensive first', async () => {
    show(report);
    const models = await screen.findByTestId('margin-models');
    const rows = [...models.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-model'));
    expect(rows).toEqual(['std-glm-5.3-flash', 'emb-bge-m3']);
    expect(models.textContent).toContain('Embedding (file search)');
    expect(models.querySelector('progress')!.getAttribute('value')).toBe('96');
  });

  it('says when a month has nothing in it', async () => {
    show(empty);
    expect((await screen.findByTestId('margin-empty')).textContent).toContain('No company');
    expect(screen.queryByTestId('margin-table')).toBeNull();
    expect(screen.getByTestId('margin-basis')).toBeTruthy();
  });

  it('asks for the month chosen', async () => {
    const fetch = show(empty);
    await screen.findByTestId('margin-empty');
    fireEvent.change(screen.getByTestId('margin-month'), { target: { value: '2026-03' } });
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/admin/margin?month=2026-03', expect.anything()),
    );
  });

  it('is Turkish first', async () => {
    await i18n.changeLanguage('tr');
    show(report);
    await screen.findByTestId('margin-table');
    expect(screen.getByTestId('margin-basis').textContent).toContain('liste fiyatımızdır');
    expect(screen.getByTestId('margin-table').textContent).toContain('Platform toplamı');
  });

  it('says so if it could not load', async () => {
    vi.spyOn(api, 'apiFetch').mockRejectedValue(new api.ApiError(403, 'forbidden'));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ProviderMargin getToken={async () => 'token'} />
      </QueryClientProvider>,
    );
    await screen.findByTestId('margin-error');
    expect(screen.queryByTestId('margin-table')).toBeNull();
  });
});
