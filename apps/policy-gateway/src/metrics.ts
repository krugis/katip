// SPDX-License-Identifier: AGPL-3.0-only
// Prometheus metrics (LLD-03 §7, tracker P1-15). Labels hold company slugs, model ids and
// fixed words, never users, prompts or anything a caller typed.
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Before a request has been tied to a company, or to a model. */
export const UNKNOWN = 'unknown';

const LATENCY_BUCKETS = [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const OVERHEAD_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.08, 0.12, 0.25, 0.5, 1, 2.5, 5, 10, 30];

export class GatewayMetrics {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: 'gw_requests_total',
    help: 'Chat and embedding requests, by how they ended',
    labelNames: ['tenant', 'alias', 'model', 'status'] as const,
    registers: [this.registry],
  });
  readonly tokens = new Counter({
    name: 'gw_tokens_total',
    help: 'Tokens, by direction',
    labelNames: ['tenant', 'class', 'dir'] as const,
    registers: [this.registry],
  });
  /**
   * What each company's requests cost us at list price, in micro-USD (P1-43, for the budget
   * anomaly alert). Our cost, so provider-only: it is on this token-protected port, and in
   * Prometheus and Grafana, which only the provider can reach.
   */
  readonly cost = new Counter({
    name: 'gw_cost_usd_micro_total',
    help: 'Cost of requests at list price, in micro-USD',
    labelNames: ['tenant', 'class'] as const,
    registers: [this.registry],
  });
  readonly upstreamLatency = new Histogram({
    name: 'gw_upstream_latency_seconds',
    help: 'From calling a model to its first response headers',
    labelNames: ['tenant', 'model'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });
  readonly overhead = new Histogram({
    name: 'gw_overhead_seconds',
    help: 'What the gateway adds before calling a model, personal data checks included',
    labelNames: ['tenant'] as const,
    buckets: OVERHEAD_BUCKETS,
    registers: [this.registry],
  });
  readonly upstreamErrors = new Counter({
    name: 'gw_upstream_errors_total',
    help: 'Calls to a model that failed and moved on to the next, if any',
    labelNames: ['model'] as const,
    registers: [this.registry],
  });
  readonly piiEntities = new Counter({
    name: 'gw_pii_entities_total',
    help: 'Personal data values masked, by kind',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });
  readonly piiDetectorFailures = new Counter({
    name: 'gw_pii_detector_failures_total',
    help: 'Requests where names could not be checked',
    labelNames: ['tenant', 'action'] as const,
    registers: [this.registry],
  });
  readonly quotaDenials = new Counter({
    name: 'gw_quota_denials_total',
    help: 'Requests refused for being over quota',
    labelNames: ['tenant', 'class'] as const,
    registers: [this.registry],
  });

  constructor({ processMetrics = false }: { processMetrics?: boolean } = {}) {
    if (processMetrics) collectDefaultMetrics({ register: this.registry });
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * On its own port, with a token. The port isn't routed from outside, but every company's
 * LibreChat can reach this container, and these numbers show every company's usage.
 */
export function buildMetricsServer(metrics: GatewayMetrics, token: string): FastifyInstance {
  const app = Fastify({ logger: false });
  app.get('/metrics', async (req, reply) => {
    const sent = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
    if (!timingSafeEqual(digest(sent), digest(token))) {
      return reply.code(401).send({ code: 'unauthorized' });
    }
    return reply
      .header('content-type', metrics.registry.contentType)
      .send(await metrics.registry.metrics());
  });
  return app;
}
