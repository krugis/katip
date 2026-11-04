// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { buildMetricsServer, renderPlatformMetrics, type PlatformHealth } from '../src/metrics.js';

const TOKEN = 'm'.repeat(40);
const health: PlatformHealth = {
  dailyRun: { ts: new Date('2026-11-04T03:30:00Z'), details: { failed: 2 } },
  failedJobs: [
    { type: 'tenant.purge', failed: 1 },
    { type: 'Robert"); drop', failed: 3 },
  ],
  tenants: [
    { status: 'active', count: 2 },
    { status: 'suspended', count: 1 },
  ],
};

describe('platform metrics (P1-43)', () => {
  it('reports the daily job, failed jobs and companies by status', () => {
    const out = renderPlatformMetrics(health);
    expect(out).toContain('katip_daily_job_last_run_timestamp_seconds 1793763000');
    expect(out).toContain('katip_daily_job_last_run_failed 2');
    expect(out).toContain('katip_daily_job_never_run 0');
    expect(out).toContain('katip_jobs_failed_24h{type="tenant.purge"} 1');
    expect(out).toContain('katip_tenants{status="active"} 2');
  });

  it('never puts an unexpected word in a label', () => {
    expect(renderPlatformMetrics(health)).toContain('katip_jobs_failed_24h{type="other"} 3');
  });

  it('says when the daily job never ran, with no time', () => {
    const out = renderPlatformMetrics({ dailyRun: null, failedJobs: [], tenants: [] });
    expect(out).toContain('katip_daily_job_never_run 1');
    expect(out).not.toMatch(/^katip_daily_job_last_run_timestamp_seconds /m);
  });

  it('asks for the token', async () => {
    const app = buildMetricsServer({ platformHealth: async () => health }, TOKEN);
    const none = await app.inject({ url: '/metrics' });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({ url: '/metrics', headers: { authorization: 'Bearer x' } });
    expect(wrong.statusCode).toBe(401);
    const ok = await app.inject({
      url: '/metrics',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('katip_tenants{status="suspended"} 1');
    await app.close();
  });
});
