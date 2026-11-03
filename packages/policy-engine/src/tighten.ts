// SPDX-License-Identifier: AGPL-3.0-only
// A department may only be stricter than its company (LLD-04 §3). This holds whatever is
// stored: a company that tightens later must not leave a department looser than itself.
import type { LimitBehaviour, TenantPolicy } from './types.js';

export type DepartmentOverride = Partial<
  Pick<TenantPolicy, 'aliases' | 'allowedModels' | 'atQuotaLimit'>
>;

const LIMIT_STRICTNESS: Record<LimitBehaviour, number> = { overage: 0, downgrade: 1, block: 2 };

export function tightenPolicy(base: TenantPolicy, override: DepartmentOverride): TenantPolicy {
  const aliases = { ...base.aliases };
  for (const key of Object.keys(aliases) as (keyof typeof aliases)[]) {
    // On only if the company has it on, and the department hasn't turned it off.
    aliases[key] = base.aliases[key] && (override.aliases?.[key] ?? true);
  }

  // Empty means every enabled model.
  let allowedModels = base.allowedModels;
  if (override.allowedModels && override.allowedModels.length > 0) {
    allowedModels =
      base.allowedModels.length === 0
        ? override.allowedModels
        : override.allowedModels.filter((m) => base.allowedModels.includes(m));
    // Nothing in common: keep the company's list, not "every model", which is what empty means.
    if (allowedModels.length === 0) allowedModels = base.allowedModels;
  }

  const wanted = override.atQuotaLimit ?? base.atQuotaLimit;
  const atQuotaLimit =
    LIMIT_STRICTNESS[wanted] > LIMIT_STRICTNESS[base.atQuotaLimit] ? wanted : base.atQuotaLimit;

  return { ...base, aliases, allowedModels, atQuotaLimit };
}
