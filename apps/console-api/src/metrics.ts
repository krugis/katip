// SPDX-License-Identifier: AGPL-3.0-only
// Platform health for Prometheus (P1-43, LLD-10 §5): the daily job, failed jobs and companies by
// status. Counts and times only: no company's id, no person, no money.
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { dailyJobState } from './audit.js';

export interface PlatformHealth {
  dailyRun: { ts: Date; details: Record<string, unknown> | null } | null;
  /** Jobs that failed in the last 24 hours, by type. */
  failedJobs: { type: string; failed: number }[];
  tenants: { status: string; count: number }[];
}

export interface PlatformHealthSource {
  platformHealth(): Promise<PlatformHealth>;
}

/** Label values are words from our own code, but are checked anyway. */
const label = (v: string) => (/^[a-z0-9_.-]{1,64}$/.test(v) ? v : 'other');

export function renderPlatformMetrics(h: PlatformHealth): string {
  const state = dailyJobState(h.dailyRun);
  const lines = [
    '# HELP katip_daily_job_last_run_timestamp_seconds When the daily job last ran',
    '# TYPE katip_daily_job_last_run_timestamp_seconds gauge',
  ];
  if (h.dailyRun) {
    lines.push(`katip_daily_job_last_run_timestamp_seconds ${h.dailyRun.ts.getTime() / 1000}`);
  }
  lines.push(
    '# HELP katip_daily_job_last_run_failed Failures in the last daily run',
    '# TYPE katip_daily_job_last_run_failed gauge',
    `katip_daily_job_last_run_failed ${state.failed}`,
    '# HELP katip_daily_job_never_run 1 if no daily run is on record',
    '# TYPE katip_daily_job_never_run gauge',
    `katip_daily_job_never_run ${state.state === 'never' ? 1 : 0}`,
    '# HELP katip_jobs_failed_24h Jobs that failed in the last 24 hours, by type',
    '# TYPE katip_jobs_failed_24h gauge',
  );
  for (const j of h.failedJobs) {
    lines.push(`katip_jobs_failed_24h{type="${label(j.type)}"} ${j.failed}`);
  }
  lines.push('# HELP katip_tenants Companies, by status', '# TYPE katip_tenants gauge');
  for (const t of h.tenants) lines.push(`katip_tenants{status="${label(t.status)}"} ${t.count}`);
  return `${lines.join('\n')}\n`;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * On its own port with the gateway's metrics token. It isn't routed: Traefik sends only /api on
 * the console's host to this service.
 */
export function buildMetricsServer(source: PlatformHealthSource, token: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (req, reply) => {
    const sent = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
    if (!timingSafeEqual(digest(sent), digest(token))) {
      return reply.code(401).send({ code: 'unauthorized' });
    }
    return reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(renderPlatformMetrics(await source.platformHealth()));
  });
  return app;
}
