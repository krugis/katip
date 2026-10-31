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
  /**
   * DEV ONLY until tracker P1-17 (Postgres): JSON file with tenants, keys and users.
   * See apps/policy-gateway/dev-tenants.example.json.
   */
  DEV_TENANTS_FILE: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(ConfigSchema, source);
}
