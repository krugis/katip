// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Alias,
  ModelEntry,
  Residency,
  RouteCondition,
  RouteDecision,
  RouteRequest,
  RouterRule,
  TenantPolicy,
} from './types.js';

export class RouteDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'RouteDeniedError';
  }
}

/** A company asked for embeddings, and no model it may use can make them. */
export class NoEmbeddingModelError extends RouteDeniedError {
  constructor(public readonly residency: Residency) {
    super(`no embedding model is allowed under ${residency}`);
    this.name = 'NoEmbeddingModelError';
  }
}

/** Data policies allowed for customer data (ADR-011). */
const ALLOWED_DATA_POLICIES = new Set(['zero_retention', 'retention_30d']);

function matches(cond: RouteCondition, req: RouteRequest, policy: TenantPolicy): boolean {
  if (cond.alias && !cond.alias.includes(req.alias)) return false;
  if (cond.residency && !cond.residency.includes(policy.residency)) return false;
  if (cond.background !== undefined && cond.background !== req.background) return false;
  if (cond.requiresPremiumQuota && !req.premiumQuotaAvailable) return false;

  // Escalation conditions are OR-ed: long input OR explicit reasoning hint.
  const escalation: boolean[] = [];
  if (cond.minInputTokens !== undefined) escalation.push(req.inputTokens >= cond.minInputTokens);
  if (cond.reasoningHint !== undefined) escalation.push(req.reasoningHint === cond.reasoningHint);
  if (escalation.length > 0 && !escalation.some(Boolean)) return false;
  return true;
}

/** What holds however a model is chosen: it's on, its data policy is approved, its region fits. */
function servableUnder(
  m: Pick<ModelEntry, 'enabled' | 'dataPolicy' | 'region'>,
  residency: Residency,
): boolean {
  if (!m.enabled) return false;
  if (!ALLOWED_DATA_POLICIES.has(m.dataPolicy)) return false;
  if (residency === 'TR_ONLY' && m.region !== 'tr') return false;
  if (residency === 'EU_ONLY' && !(m.region === 'eu' || m.region === 'tr')) return false;
  return true;
}

function allowedForTenant(m: ModelEntry, policy: TenantPolicy): boolean {
  if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(m.id)) return false;
  return servableUnder(m, policy.residency);
}

/** Whether file search can work under each data location rule, for the console to say so. */
export function embeddingByResidency(
  catalog: Pick<ModelEntry, 'class' | 'enabled' | 'dataPolicy' | 'region'>[],
): Record<Residency, boolean> {
  const any = (residency: Residency) =>
    catalog.some((m) => m.class === 'embedding' && servableUnder(m, residency));
  return { ANY_APPROVED: any('ANY_APPROVED'), EU_ONLY: any('EU_ONLY'), TR_ONLY: any('TR_ONLY') };
}

/**
 * Picks the route for a request: the first matching rule (lowest priority number wins),
 * filtered by tenant policy. Throws RouteDeniedError if nothing is allowed.
 */
export function chooseRoute(
  req: RouteRequest,
  rules: RouterRule[],
  catalog: ModelEntry[],
  policy: TenantPolicy,
): RouteDecision {
  if (!policy.aliases[req.alias]) {
    throw new RouteDeniedError(`model alias "${req.alias}" is not enabled for this company`);
  }
  const byId = new Map(catalog.map((m) => [m.id, m]));
  const ordered = [...rules].sort((a, b) => a.priority - b.priority);

  for (const rule of ordered) {
    if (!matches(rule.when, req, policy)) continue;
    const candidates = rule.models
      .map((id) => byId.get(id))
      .filter((m): m is ModelEntry => m !== undefined && allowedForTenant(m, policy));
    if (candidates.length === 0) {
      if (rule.strict) throw new RouteDeniedError(`no allowed model for rule ${rule.id}`);
      continue;
    }
    return { ruleId: rule.id, class: candidates[0]!.class, candidates };
  }
  throw new RouteDeniedError('no routing rule matched an allowed model');
}

/**
 * Picks the model for an embedding request: `auto` is the tenant's first allowed embedding
 * model, `tr-local` the first hosted in Türkiye, anything else one by its id. Always one model:
 * a vector only compares with vectors from the same model, so a fallback would quietly leave
 * a file unsearchable. `allowedModels` doesn't apply: it's the list of chat choices, and the
 * console can't name an embedding model in it. Residency and the data policy do apply. Throws
 * NoEmbeddingModelError if nothing the company may use can embed, and RouteDeniedError for
 * something that isn't an embedding model.
 */
export function chooseEmbeddingRoute(
  requested: string,
  catalog: ModelEntry[],
  policy: TenantPolicy,
): RouteDecision {
  if ((requested === 'auto' || requested === 'tr-local') && !policy.aliases[requested]) {
    throw new RouteDeniedError(`model alias "${requested}" is not enabled for this company`);
  }
  const allowed = catalog.filter(
    (m) => m.class === 'embedding' && servableUnder(m, policy.residency),
  );
  const model =
    requested === 'auto'
      ? allowed[0]
      : requested === 'tr-local'
        ? allowed.find((m) => m.region === 'tr')
        : allowed.find((m) => m.id === requested);
  if (!model) {
    const known =
      requested === 'auto' ||
      requested === 'tr-local' ||
      catalog.some((m) => m.class === 'embedding' && m.id === requested);
    if (known) throw new NoEmbeddingModelError(policy.residency);
    throw new RouteDeniedError(`no allowed embedding model for "${requested}"`);
  }
  return { ruleId: 'embedding', class: model.class, candidates: [model] };
}

/**
 * Whether everything this route could reach is marked self-hosted. Every candidate counts, so
 * a fallback to an outside model, were one ever added, keeps the text masked. Only a real
 * `true` counts: a marker that's absent or anything else means outside.
 */
export function reachesOnlySelfHosted(decision: Pick<RouteDecision, 'candidates'>): boolean {
  return decision.candidates.length > 0 && decision.candidates.every((m) => m.selfHosted === true);
}

/** Aliases visible to a tenant in GET /v1/models. */
export function visibleAliases(policy: TenantPolicy, kvkkAddon: boolean): Alias[] {
  return (Object.keys(policy.aliases) as Alias[]).filter(
    (a) => policy.aliases[a] && (a !== 'tr-local' || kvkkAddon),
  );
}
