// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG,
  DEFAULT_POLICY,
  DEFAULT_RULES,
  RouteDeniedError,
  chooseRoute,
  costMicroUsd,
  crossedThresholds,
  decideQuota,
  estimateTokens,
  visibleAliases,
  type RouteRequest,
  type TenantPolicy,
} from '../src/index.js';

const req = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  alias: 'auto',
  inputTokens: 500,
  background: false,
  reasoningHint: false,
  premiumQuotaAvailable: true,
  ...over,
});
const route = (r: RouteRequest, p: TenantPolicy = DEFAULT_POLICY) =>
  chooseRoute(r, DEFAULT_RULES, DEFAULT_CATALOG, p);

describe('router rules v1', () => {
  it('auto → DeepSeek V4 Flash with standard fallbacks', () => {
    const d = route(req());
    expect(d.ruleId).toBe('auto-default');
    expect(d.class).toBe('standard');
    expect(d.candidates.map((c) => c.id)).toEqual([
      'std-deepseek-v4-flash',
      'std-glm-5.3-flash',
      'std-gemma-4-26b',
    ]);
  });

  it('auto escalates to premium for long input when premium quota is left', () => {
    expect(route(req({ inputTokens: 70_000 })).ruleId).toBe('auto-escalate');
    expect(route(req({ reasoningHint: true })).class).toBe('premium');
  });

  it('auto does not escalate when premium quota is exhausted', () => {
    expect(route(req({ inputTokens: 70_000, premiumQuotaAvailable: false })).ruleId).toBe(
      'auto-default',
    );
  });

  it('best → premium, fast → standard', () => {
    expect(route(req({ alias: 'best' })).candidates[0]!.id).toBe('prem-claude-sonnet-5.5');
    expect(route(req({ alias: 'fast' })).class).toBe('standard');
  });

  it('background tasks use the cheapest standard model', () => {
    expect(route(req({ background: true })).candidates[0]!.id).toBe('std-glm-5.3-flash');
  });

  it('TR_ONLY residency forces the Turkey model and never falls back abroad', () => {
    const p: TenantPolicy = { ...DEFAULT_POLICY, residency: 'TR_ONLY' };
    const d = route(req({ alias: 'best' }), p);
    expect(d.candidates.map((c) => c.id)).toEqual(['tr-gpt-oss-120b']);
  });

  it('TR_ONLY with the TR model disabled is denied, not silently routed abroad', () => {
    const p: TenantPolicy = {
      ...DEFAULT_POLICY,
      residency: 'TR_ONLY',
      allowedModels: ['std-deepseek-v4-flash'],
    };
    expect(() => route(req(), p)).toThrow(RouteDeniedError);
  });

  it('disabled alias is denied', () => {
    expect(() => route(req({ alias: 'tr-local' }))).toThrow(/not enabled/);
  });

  it('respects the tenant model allow-list', () => {
    const p: TenantPolicy = { ...DEFAULT_POLICY, allowedModels: ['std-gemma-4-26b'] };
    expect(route(req(), p).candidates.map((c) => c.id)).toEqual(['std-gemma-4-26b']);
  });

  it('tr-local alias is only visible with the KVKK add-on', () => {
    const p: TenantPolicy = {
      ...DEFAULT_POLICY,
      aliases: { ...DEFAULT_POLICY.aliases, 'tr-local': true },
    };
    expect(visibleAliases(p, false)).not.toContain('tr-local');
    expect(visibleAliases(p, true)).toContain('tr-local');
  });
});

describe('quota math', () => {
  it('estimates tokens from Turkish text length', () => {
    expect(estimateTokens('Merhaba dünya')).toBe(4);
  });
  it('computes cost in integer micro-USD', () => {
    const m = DEFAULT_CATALOG[0]!; // $0.09 / $0.18 per 1M
    expect(costMicroUsd(m, 3000, 500)).toBe(360); // 0.00036 USD
  });
  it('decides allow / overage / downgrade / block', () => {
    expect(decideQuota(10, 100, 50, 'block', true)).toBe('allow');
    expect(decideQuota(90, 100, 50, 'overage', true)).toBe('overage');
    expect(decideQuota(90, 100, 50, 'downgrade', true)).toBe('downgrade');
    expect(decideQuota(90, 100, 50, 'downgrade', false)).toBe('block');
    expect(decideQuota(90, 100, 50, 'block', true)).toBe('block');
  });
  it('reports crossed thresholds once', () => {
    expect(crossedThresholds(40, 85, 100)).toEqual([50, 80]);
    expect(crossedThresholds(85, 90, 100)).toEqual([]);
    expect(crossedThresholds(99, 100, 100)).toEqual([100]);
  });
});
