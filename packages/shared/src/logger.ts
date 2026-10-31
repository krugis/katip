// SPDX-License-Identifier: AGPL-3.0-only
import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Paths that may contain personal data or secrets. They are always redacted.
 * Rule (CLAUDE.md §5): log ids, never prompt text.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-user-email"]',
  'headers.authorization',
  'authorization',
  'apiKey',
  'password',
  'secret',
  'token',
  'messages',
  'prompt',
  'input',
  'content',
  'body.messages',
  'body.input',
  'body.prompt',
  '*.messages',
  '*.content',
  '*.prompt',
  'email',
  '*.email',
];

export function createLogger(name: string, opts: LoggerOptions = {}): Logger {
  return pino({
    name,
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...opts,
  });
}

export type { Logger };
