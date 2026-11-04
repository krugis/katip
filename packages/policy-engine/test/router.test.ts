// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CATALOG,
  DEFAULT_POLICY,
  DEFAULT_RULES,
  RouteDeniedError,
  chooseEmbeddingRoute,
  embeddingByResidency,
  NoEmbeddingModelError,
  reachesOnlySelfHosted,
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

describe('embedding route', () => {
  const emb = DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!;
  const emTr = { ...emb, id: 'emb-tr', region: 'tr' as const };
  const emEu = { ...emb, id: 'emb-eu', region: 'eu' as const };
  const catalog = [...DEFAULT_CATALOG, emEu, emTr];
  const ids = (requested: string, policy: TenantPolicy = DEFAULT_POLICY, c = catalog) =>
    chooseEmbeddingRoute(requested, c, policy).candidates.map((m) => m.id);
  const trOn: TenantPolicy = {
    ...DEFAULT_POLICY,
    aliases: { ...DEFAULT_POLICY.aliases, 'tr-local': true },
  };

  it('gives one model, never a fallback: vectors from another would not compare', () => {
    expect(ids('auto')).toEqual(['emb-bge-m3']);
    expect(ids('emb-eu')).toEqual(['emb-eu']);
    expect(chooseEmbeddingRoute('auto', catalog, DEFAULT_POLICY).class).toBe('embedding');
  });

  it('refuses anything that is not an embedding model', () => {
    for (const requested of ['fast', 'best', 'std-deepseek-v4-flash', 'bilinmeyen']) {
      expect(() => ids(requested)).toThrow(RouteDeniedError);
    }
  });

  it("isn't limited by allowedModels, a list of chat choices that can't name it", () => {
    const chatOnly = { ...DEFAULT_POLICY, allowedModels: ['std-deepseek-v4-flash'] };
    expect(ids('auto', chatOnly)).toEqual(['emb-bge-m3']);
    expect(ids('emb-eu', chatOnly)).toEqual(['emb-eu']);
    expect(() => ids('emb-bge-m3', { ...chatOnly, residency: 'TR_ONLY' })).toThrow(
      NoEmbeddingModelError,
    );
  });

  it('says when no embedding model fits, and not for a chat model', () => {
    const only = { ...DEFAULT_POLICY, residency: 'EU_ONLY' as const };
    const refuse = (requested: string) => () => ids(requested, only, [emb]);
    expect(refuse('auto')).toThrow(NoEmbeddingModelError);
    expect(refuse('emb-bge-m3')).toThrow(NoEmbeddingModelError);
    expect(refuse('emb-bge-m3')).toThrow(/EU_ONLY/);
    expect(() => ids('std-deepseek-v4-flash', only)).toThrow(RouteDeniedError);
    expect(() => ids('std-deepseek-v4-flash', only)).not.toThrow(NoEmbeddingModelError);
  });

  it('follows a disabled model and the data policy', () => {
    expect(() => ids('auto', DEFAULT_POLICY, [{ ...emb, enabled: false }])).toThrow(
      RouteDeniedError,
    );
    expect(() => ids('auto', DEFAULT_POLICY, [{ ...emb, dataPolicy: 'may_train' }])).toThrow(
      RouteDeniedError,
    );
  });

  it('follows residency', () => {
    expect(ids('auto', { ...DEFAULT_POLICY, residency: 'TR_ONLY' })).toEqual(['emb-tr']);
    expect(ids('auto', { ...DEFAULT_POLICY, residency: 'EU_ONLY' })).toEqual(['emb-eu']);
    expect(() => ids('emb-bge-m3', { ...DEFAULT_POLICY, residency: 'TR_ONLY' })).toThrow(
      RouteDeniedError,
    );
    expect(() => ids('auto', { ...DEFAULT_POLICY, residency: 'TR_ONLY' }, DEFAULT_CATALOG)).toThrow(
      RouteDeniedError,
    );
  });

  it('keeps tr-local to Türkiye and to companies with it on', () => {
    expect(ids('tr-local', trOn)).toEqual(['emb-tr']);
    expect(() => ids('tr-local')).toThrow(RouteDeniedError);
    expect(() => ids('tr-local', trOn, DEFAULT_CATALOG)).toThrow(RouteDeniedError);
  });

  it('follows auto being off', () => {
    const off = { ...DEFAULT_POLICY, aliases: { ...DEFAULT_POLICY.aliases, auto: false } };
    expect(() => ids('auto', off)).toThrow(RouteDeniedError);
    expect(ids('emb-bge-m3', off)).toEqual(['emb-bge-m3']);
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

describe('reachesOnlySelfHosted', () => {
  const emb = DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!;
  const local = { ...emb, id: 'emb-local', selfHosted: true };
  const route = (...candidates: unknown[]) => ({ candidates }) as never;

  it('is true only of a real true on every candidate', () => {
    expect(reachesOnlySelfHosted(route(local))).toBe(true);
    expect(reachesOnlySelfHosted(route(local, { ...local, id: 'b' }))).toBe(true);
  });

  it('is false for an absent or unclear marker', () => {
    expect(reachesOnlySelfHosted(route(emb))).toBe(false);
    for (const selfHosted of [false, 'true', 1, null, undefined]) {
      expect(reachesOnlySelfHosted(route({ ...emb, selfHosted }))).toBe(false);
    }
  });

  it('is false if a fallback could reach an outside model, whichever comes first', () => {
    expect(reachesOnlySelfHosted(route(local, emb))).toBe(false);
    expect(reachesOnlySelfHosted(route(emb, local))).toBe(false);
    expect(reachesOnlySelfHosted(route())).toBe(false);
  });

  it('holds on the checked-in defaults: nothing is marked', () => {
    expect(DEFAULT_CATALOG.some((m) => m.selfHosted === true)).toBe(false);
  });
});

describe('embeddingByResidency', () => {
  const emb = DEFAULT_CATALOG.find((m) => m.id === 'emb-bge-m3')!;

  it('says a global model only serves a company with no region rule', () => {
    expect(embeddingByResidency([emb])).toEqual({
      ANY_APPROVED: true,
      EU_ONLY: false,
      TR_ONLY: false,
    });
  });

  it('counts a model by its region, as routing does', () => {
    expect(embeddingByResidency([{ ...emb, region: 'eu' }])).toEqual({
      ANY_APPROVED: true,
      EU_ONLY: true,
      TR_ONLY: false,
    });
    expect(embeddingByResidency([{ ...emb, region: 'tr' }]).TR_ONLY).toBe(true);
  });

  it('ignores chat models, disabled models and an unapproved data policy', () => {
    const none = { ANY_APPROVED: false, EU_ONLY: false, TR_ONLY: false };
    const chat = DEFAULT_CATALOG.filter((m) => m.class !== 'embedding');
    expect(embeddingByResidency(chat)).toEqual(none);
    expect(embeddingByResidency([{ ...emb, enabled: false }])).toEqual(none);
    expect(embeddingByResidency([{ ...emb, dataPolicy: 'may_train' }])).toEqual(none);
  });
});
