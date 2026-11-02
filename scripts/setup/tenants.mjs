// SPDX-License-Identifier: AGPL-3.0-only
// Per-tenant secrets, in a generated file per tenant (LLD-07). You edit katip.env; these
// are never edited by hand. A secrets file also marks a tenant as known on this host, so
// tenants created by `pnpm tenant:create` survive re-runs and are removed by rollback.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tenantSecretName, TENANT_SECRETS } from './config.mjs';
import { generatorFor, parseEnvFile } from './util.mjs';

const SUFFIX = '.secrets.env';

export const tenantSecretsFile = (infra, slug) => join(infra, 'env', 'tenants', `${slug}${SUFFIX}`);

/** Reads a tenant's secrets, generating whatever is missing. Existing values never change. */
export function ensureTenantSecrets(infra, slug) {
  const file = tenantSecretsFile(infra, slug);
  const existing = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {};
  const out = {};
  let changed = !existsSync(file);
  for (const name of TENANT_SECRETS) {
    const key = tenantSecretName(slug, name);
    out[key] = existing[key] || generatorFor(key)();
    if (!existing[key]) changed = true;
  }
  if (changed) {
    mkdirSync(join(infra, 'env', 'tenants'), { recursive: true });
    const lines = Object.entries(out).map(([k, v]) => `${k}=${v}`);
    writeFileSync(file, `# Generated. Do not edit.\n${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  return out;
}

/**
 * Tenant secrets used to live in katip.env. Moves them to their own files, keeping the
 * values: new ones would lock out existing logins. Run before katip.env is rewritten.
 */
export function adoptTenantSecretsFromEnvFile(infra) {
  const envFile = join(infra, 'env', 'katip.env');
  if (!existsSync(envFile)) return;
  const pattern = new RegExp(`^KATIP_T_(.+)_(?:${TENANT_SECRETS.join('|')})$`);
  const bySlug = new Map();
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(envFile, 'utf8')))) {
    const match = pattern.exec(key);
    if (!match || !value) continue;
    const slug = match[1].toLowerCase().replaceAll('_', '-');
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), `${key}=${value}`]);
  }
  for (const [slug, lines] of bySlug) {
    const file = tenantSecretsFile(infra, slug);
    if (existsSync(file)) continue;
    mkdirSync(join(infra, 'env', 'tenants'), { recursive: true });
    writeFileSync(file, `# Generated. Do not edit.\n${lines.join('\n')}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}

/** Every tenant with a secrets file on this host. */
export function knownTenantSlugs(infra) {
  const dir = join(infra, 'env', 'tenants');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => f.slice(0, -SUFFIX.length))
    .sort();
}
