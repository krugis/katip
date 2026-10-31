// SPDX-License-Identifier: AGPL-3.0-only
import { z, type ZodTypeAny } from 'zod';

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates environment variables against a Zod schema and fails fast.
 * Values are never echoed back in errors (they may be secrets); only variable names and reasons.
 */
export function loadEnv<S extends ZodTypeAny>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvValidationError(issues);
  }
  return result.data as z.infer<S>;
}

/** Common helpers for env schemas. */
export const envBool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envPort = z.coerce.number().int().min(1).max(65535);
