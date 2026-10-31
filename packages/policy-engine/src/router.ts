// SPDX-License-Identifier: AGPL-3.0-only
import type {
  Alias,
  ModelEntry,
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

function allowedForTenant(m: ModelEntry, policy: TenantPolicy): boolean {
  if (!m.enabled) return false;
  if (!ALLOWED_DATA_POLICIES.has(m.dataPolicy)) return false;
  if (policy.allowedModels.length > 0 && !policy.allowedModels.includes(m.id)) return false;
  if (policy.residency === 'TR_ONLY' && m.region !== 'tr') return false;
  if (policy.residency === 'EU_ONLY' && !(m.region === 'eu' || m.region === 'tr')) return false;
  return true;
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

/** Aliases visible to a tenant in GET /v1/models. */
export function visibleAliases(policy: TenantPolicy, kvkkAddon: boolean): Alias[] {
  return (Object.keys(policy.aliases) as Alias[]).filter(
    (a) => policy.aliases[a] && (a !== 'tr-local' || kvkkAddon),
  );
}
