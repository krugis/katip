// SPDX-License-Identifier: AGPL-3.0-only
import type { ModelEntry, RouterRule, TenantPolicy } from './types.js';

/**
 * Seed catalog (LLD-03 §3 / LLD-05 §4). Prices are list prices per 1M tokens in micro-USD,
 * from the OpenRouter price pull of 31 Oct 2026 (privacy-safe provider column).
 * In production the catalog lives in Postgres; this is the dev/test default.
 */
export const DEFAULT_CATALOG: ModelEntry[] = [
  {
    id: 'std-deepseek-v4-flash',
    litellmName: 'std-deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    class: 'standard',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInMicroPerM: 90_000,
    priceOutMicroPerM: 180_000,
    enabled: true,
  },
  {
    id: 'std-glm-5.3-flash',
    litellmName: 'std-glm-5.3-flash',
    displayName: 'GLM-5.3 Flash',
    class: 'standard',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInMicroPerM: 84_000,
    priceOutMicroPerM: 280_000,
    enabled: true,
  },
  {
    id: 'std-gemma-4-26b',
    litellmName: 'std-gemma-4-26b',
    displayName: 'Gemma 4 26B',
    class: 'standard',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInMicroPerM: 70_000,
    priceOutMicroPerM: 340_000,
    enabled: true,
  },
  {
    id: 'prem-claude-sonnet-5.5',
    litellmName: 'prem-claude-sonnet-5.5',
    displayName: 'Claude Sonnet 5.5',
    class: 'premium',
    region: 'global',
    dataPolicy: 'retention_30d',
    priceInMicroPerM: 2_000_000,
    priceOutMicroPerM: 10_000_000,
    enabled: true,
  },
  {
    id: 'prem-gemini-4-argon',
    litellmName: 'prem-gemini-4-argon',
    displayName: 'Gemini 4 Argon',
    class: 'premium',
    region: 'eu',
    dataPolicy: 'zero_retention',
    priceInMicroPerM: 2_000_000,
    priceOutMicroPerM: 10_000_000,
    enabled: true,
  },
  {
    id: 'tr-gpt-oss-120b',
    litellmName: 'tr-gpt-oss-120b',
    displayName: 'gpt-oss-120b (Türkiye)',
    class: 'tr',
    region: 'tr',
    dataPolicy: 'zero_retention',
    priceInMicroPerM: 150_000,
    priceOutMicroPerM: 600_000,
    enabled: true,
  },
  {
    id: 'emb-bge-m3',
    litellmName: 'emb-bge-m3',
    displayName: 'BGE-M3 embeddings',
    class: 'embedding',
    region: 'global',
    dataPolicy: 'zero_retention',
    priceInMicroPerM: 10_000,
    priceOutMicroPerM: 0,
    enabled: true,
  },
];

const STANDARD = ['std-deepseek-v4-flash', 'std-glm-5.3-flash', 'std-gemma-4-26b'];
const PREMIUM = ['prem-claude-sonnet-5.5', 'prem-gemini-4-argon'];

/** Router rules v1 (LLD-03 §4). Lower priority number is evaluated first. */
export const DEFAULT_RULES: RouterRule[] = [
  {
    id: 'tr-only',
    priority: 10,
    when: { residency: ['TR_ONLY'] },
    models: ['tr-gpt-oss-120b'],
    strict: true,
  },
  {
    id: 'tr-local-alias',
    priority: 15,
    when: { alias: ['tr-local'] },
    models: ['tr-gpt-oss-120b'],
    strict: true,
  },
  {
    id: 'background',
    priority: 18,
    when: { background: true },
    models: ['std-glm-5.3-flash', 'std-deepseek-v4-flash'],
  },
  { id: 'best', priority: 20, when: { alias: ['best'] }, models: PREMIUM },
  { id: 'fast', priority: 30, when: { alias: ['fast'] }, models: STANDARD },
  {
    id: 'auto-escalate',
    priority: 40,
    when: {
      alias: ['auto'],
      minInputTokens: 60_000,
      reasoningHint: true,
      requiresPremiumQuota: true,
    },
    models: PREMIUM,
  },
  { id: 'auto-default', priority: 50, when: { alias: ['auto'] }, models: STANDARD },
];

export const DEFAULT_POLICY: TenantPolicy = {
  aliases: { auto: true, fast: true, best: true, 'tr-local': false },
  allowUserModelChoice: false,
  allowedModels: [],
  atQuotaLimit: 'downgrade',
  residency: 'ANY_APPROVED',
};
