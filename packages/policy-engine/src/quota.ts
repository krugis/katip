// SPDX-License-Identifier: AGPL-3.0-only
import type { LimitBehaviour, ModelEntry } from './types.js';

/**
 * Rough token estimate for budgeting before the call (Turkish text averages ~3.5 chars/token
 * on current tokenizers). The real count from the provider settles the reservation afterwards.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Cost in integer micro-USD. Never use floats for stored money (CLAUDE.md). */
export function costMicroUsd(model: ModelEntry, inputTokens: number, outputTokens: number): number {
  return Math.round(
    (inputTokens * model.priceInMicroPerM + outputTokens * model.priceOutMicroPerM) / 1_000_000,
  );
}

export type QuotaDecision = 'allow' | 'overage' | 'downgrade' | 'block';

/**
 * Decides what to do with a request given the pooled monthly counter.
 * `used` and `limit` are in the quota unit (tokens or runs); `estimate` is this request's reservation.
 */
export function decideQuota(
  used: number,
  limit: number,
  estimate: number,
  behaviour: LimitBehaviour,
  canDowngrade: boolean,
): QuotaDecision {
  if (used + estimate <= limit) return 'allow';
  if (behaviour === 'overage') return 'overage';
  if (behaviour === 'downgrade' && canDowngrade) return 'downgrade';
  return 'block';
}

/** Threshold alerts at 50/80/100 % (LLD-03 §6). Returns thresholds crossed by this increment. */
export function crossedThresholds(before: number, after: number, limit: number): number[] {
  if (limit <= 0) return [];
  return [50, 80, 100].filter((t) => before * 100 < t * limit && after * 100 >= t * limit);
}
