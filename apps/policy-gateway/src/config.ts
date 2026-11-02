// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { envPort, loadEnv } from '@katip/shared';

export const ConfigSchema = z.object({
  PORT: envPort.default(8080),
  HOST: z.string().default('0.0.0.0'),
  /** LiteLLM proxy base URL, including /v1 (e.g. http://litellm:4000/v1). */
  LITELLM_BASE_URL: z.string().url(),
  /** LiteLLM key used by the gateway. Phase 1: one key; per-tenant virtual keys come with the provisioner. */
  LITELLM_API_KEY: z.string().min(1),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /** Postgres governance DB (P1-02). When set, tenants/users/keys come from Postgres. */
  DATABASE_URL: z.string().url().optional(),
  /** Valkey for the 60 s auth cache (optional; no cache when unset). */
  VALKEY_URL: z.string().url().optional(),
  /**
   * Presidio analyzer base URL (P1-11, optional). When set, PERSON NER
   * (TR + EN via the multilingual spaCy model) runs on every chat request.
   */
  PRESIDIO_URL: z.string().url().optional(),
  /**
   * DEV ONLY: JSON file with tenants, keys and users. Takes precedence over
   * DATABASE_URL for local runs without Postgres. See dev-tenants.example.json.
   */
  DEV_TENANTS_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(ConfigSchema, source);
}
