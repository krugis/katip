// SPDX-License-Identifier: AGPL-3.0-only
// Tells provider admins if the daily job failed or stopped: deletions and purges wait on it.
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { apiFetch, type GetToken } from './api';

interface DailyJob {
  state: 'never' | 'ok' | 'late' | 'failed';
  lastRun: string | null;
  failed: number;
}

export function DailyJobStatus({ getToken }: { getToken: GetToken }) {
  const { t, i18n } = useTranslation();
  const job = useQuery({
    queryKey: ['daily-job'],
    queryFn: () => apiFetch<DailyJob>('/admin/daily-job', getToken),
  });
  if (!job.data) return null;
  const { state, lastRun, failed } = job.data;
  const when = lastRun
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(lastRun),
      )
    : '';
  const fine = state === 'ok';
  return (
    <p
      className={`mt-4 rounded-lg border border-line bg-surface p-3 text-sm ${fine ? 'text-muted' : 'text-danger'}`}
      role={fine ? undefined : 'alert'}
      data-testid="daily-job"
      data-state={state}
    >
      {t(`dailyJob.${state}`, { when, failed })}
    </p>
  );
}
