// SPDX-License-Identifier: AGPL-3.0-only
import path from 'node:path';

/**
 * True only when `script` (process.argv[1]) is exactly `<name>.ts|js|mjs`.
 * A suffix match is not enough: scripts/setup/db-seed.mjs imports this package,
 * and running the seed CLI on that import races the migration on an empty DB.
 */
export function isCliEntry(script: string | undefined, name: string): boolean {
  if (!script) return false;
  const { name: base, ext } = path.parse(script);
  return base === name && ['.ts', '.js', '.mjs'].includes(ext);
}
