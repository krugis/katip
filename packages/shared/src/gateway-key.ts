// SPDX-License-Identifier: AGPL-3.0-only
// Gateway key generation + verification (LLD-02 §5, LLD-05).
// Key format: sk-sme-<type>-<secret>, type t (tenant) or u (user).
// The full key never touches the database: we store an argon2id hash of it
// and look up candidate rows by prefix (first 8 chars of the secret part).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hash as argonHash, hashSync, verify } from '@node-rs/argon2';

const PREFIX_LEN = 8;
const SECRET_BYTES = 24; // 32 base64url chars

// argon2id: OWASP 2024 baseline for interactive logins.
const ARGON2_PARAMS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export interface GeneratedKey {
  /** Plaintext key, shown once (tenant env only). */
  key: string;
  /** Lookup prefix stored in gateway_keys.prefix. */
  prefix: string;
  /** Argon2id hash (encoded string incl. salt + params) for gateway_keys.key_hash. */
  hash: string;
}

export async function generateGatewayKey(type: 'tenant' | 'user'): Promise<GeneratedKey> {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const prefix = secret.slice(0, PREFIX_LEN);
  const key = `sk-sme-${type === 'tenant' ? 't' : 'u'}-${secret}`;
  return { key, prefix, hash: await argonHash(key, ARGON2_PARAMS) };
}

/** Argon2id hash for a full plaintext key. */
export function hashGatewayKey(key: string): string {
  return hashSync(key, ARGON2_PARAMS);
}

export function keyPrefix(key: string): string | null {
  const m = /^sk-sme-(?:t|u)-([A-Za-z0-9_-]+)$/.exec(key);
  return m ? m[1]!.slice(0, PREFIX_LEN) : null;
}

/** Verifies a plaintext key against its stored argon2id hash. */
export async function verifyKey(key: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, key);
  } catch {
    return false;
  }
}

/** Constant-time string equality for non-secret comparisons (prefixes). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
