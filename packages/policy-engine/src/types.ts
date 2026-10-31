// SPDX-License-Identifier: AGPL-3.0-only

export type ModelClass = 'standard' | 'premium' | 'tr' | 'embedding';
export type Alias = 'auto' | 'fast' | 'best' | 'tr-local';
export type Residency = 'ANY_APPROVED' | 'EU_ONLY' | 'TR_ONLY';
export type DataPolicy = 'zero_retention' | 'retention_30d' | 'retention_unknown' | 'may_train';
export type LimitBehaviour = 'block' | 'downgrade' | 'overage';

/** One row of the model catalog (DB table `model_catalog`). Prices in micro-USD per 1M tokens. */
export interface ModelEntry {
  id: string;
  litellmName: string;
  displayName: string;
  class: ModelClass;
  region: 'eu' | 'us' | 'tr' | 'global';
  dataPolicy: DataPolicy;
  priceInMicroPerM: number;
  priceOutMicroPerM: number;
  enabled: boolean;
}

export interface TenantPolicy {
  aliases: Record<Alias, boolean>;
  allowUserModelChoice: boolean;
  /** Model ids allowed for this tenant (subset of the catalog). Empty = all enabled models. */
  allowedModels: string[];
  atQuotaLimit: LimitBehaviour;
  residency: Residency;
}

export interface RouteCondition {
  alias?: Alias[];
  residency?: Residency[];
  minInputTokens?: number;
  background?: boolean;
  /** Request explicitly asks for deeper reasoning ("think harder"). */
  reasoningHint?: boolean;
  /** Only match when premium quota is still available. */
  requiresPremiumQuota?: boolean;
}

export interface RouterRule {
  id: string;
  priority: number;
  when: RouteCondition;
  /** Ordered model ids: first is primary, the rest are fallbacks. */
  models: string[];
  /** If true, never fall back to models outside this list (e.g. TR-only). */
  strict?: boolean;
}

export interface RouteRequest {
  alias: Alias;
  inputTokens: number;
  background: boolean;
  reasoningHint: boolean;
  premiumQuotaAvailable: boolean;
}

export interface RouteDecision {
  ruleId: string;
  class: ModelClass;
  candidates: ModelEntry[];
}
