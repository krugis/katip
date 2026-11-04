// SPDX-License-Identifier: AGPL-3.0-only
import { envBool, envPort, loadEnv } from '@katip/shared';
import { z } from 'zod';

const micro = z.coerce.number().int().min(0);

export const ConfigSchema = z.object({
  PORT: envPort.default(8095),
  /** Governance DB, as katip_billing: a role row-level security binds (LLD-05 §1). */
  DATABASE_URL: z.string().url(),
  LAGO_API_URL: z.string().url(),
  LAGO_API_KEY: z.string().min(32),
  /** From katip.config.yaml's billing section (LLD-06 §2). */
  BILLING_OVERAGE_STANDARD_USD_MICRO_PER_M: micro,
  BILLING_OVERAGE_PREMIUM_USD_MICRO_PER_M: micro,
  BILLING_SEATS_IN_ADVANCE: envBool,
  BILLING_GRACE_MINUTES: z.coerce.number().int().min(0).max(59).default(10),
  BILLING_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(400).default(35),
  BILLING_RUN_EVERY_MINUTES: z.coerce.number().int().min(1).default(60),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Config = z.infer<typeof ConfigSchema>;

export const loadConfig = (source: Record<string, string | undefined> = process.env): Config =>
  loadEnv(ConfigSchema, source);
