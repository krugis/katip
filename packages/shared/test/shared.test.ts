// SPDX-License-Identifier: AGPL-3.0-only
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { z } from 'zod';
import {
  AppError,
  Errors,
  EnvValidationError,
  loadEnv,
  envPort,
  REDACT_PATHS,
} from '../src/index.js';

describe('loadEnv', () => {
  const schema = z.object({ PORT: envPort, SECRET_KEY: z.string().min(8) });

  it('parses valid env', () => {
    expect(loadEnv(schema, { PORT: '8080', SECRET_KEY: 'abcdefgh' })).toEqual({
      PORT: 8080,
      SECRET_KEY: 'abcdefgh',
    });
  });

  it('fails fast without echoing secret values', () => {
    try {
      loadEnv(schema, { PORT: '99999', SECRET_KEY: 'short' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const msg = (e as Error).message;
      expect(msg).toContain('PORT');
      expect(msg).toContain('SECRET_KEY');
      expect(msg).not.toContain('short');
    }
  });
});

describe('logger redaction', () => {
  it('never writes prompt text, emails or keys', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, sink);
    log.info(
      {
        tenant: 'acme',
        email: 'ayse@acme.com.tr',
        body: { messages: [{ role: 'user', content: 'TCKN 10000000146' }] },
        authorization: 'Bearer sk-secret',
      },
      'request',
    );
    const out = lines.join('');
    expect(out).toContain('acme');
    expect(out).not.toContain('ayse@acme.com.tr');
    expect(out).not.toContain('10000000146');
    expect(out).not.toContain('sk-secret');
  });
});

describe('AppError', () => {
  it('maps to problem+json and OpenAI error shape', () => {
    const e = Errors.quotaExceeded('premium');
    expect(e).toBeInstanceOf(AppError);
    expect(e.toProblem()).toMatchObject({
      status: 429,
      code: 'quota_exceeded',
      quotaClass: 'premium',
    });
    expect(e.toOpenAIError().error.type).toBe('rate_limit_error');
  });
});
