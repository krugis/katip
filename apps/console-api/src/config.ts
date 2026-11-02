// SPDX-License-Identifier: AGPL-3.0-only
import { envPort, loadEnv } from '@katip/shared';
import { z } from 'zod';

export const ConfigSchema = z.object({
  PORT: envPort.default(8081),
  HOST: z.string().default('0.0.0.0'),
  /** Governance DB, as katip_console: a role row-level security binds (LLD-05 §1). */
  DATABASE_URL: z.string().url(),
  /** Must equal the token's `iss`: Keycloak's public URL for the realm. */
  OIDC_ISSUER: z.string().url(),
  /** Where to fetch signing keys; may be an internal address. */
  OIDC_JWKS_URL: z.string().url(),
  OIDC_AUDIENCE: z.string().default('console-api'),
  /** The internal identity service, which holds the Keycloak rights this API must not. */
  IDENTITY_URL: z.string().url(),
  IDENTITY_TOKEN: z.string().min(32),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  return loadEnv(ConfigSchema, source);
}
