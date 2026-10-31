// SPDX-License-Identifier: AGPL-3.0-only
// Fails if a production dependency uses a licence outside the allowlist (CLAUDE.md §8).
import { execSync } from 'node:child_process';

const ALLOWED = new Set([
  'MIT',
  'MIT-0',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MPL-2.0',
  '0BSD',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Unlicense',
]);
const out = execSync('pnpm licenses list --prod --json', { encoding: 'utf8' });
const byLicense = JSON.parse(out);
const bad = Object.entries(byLicense).filter(([lic]) => !ALLOWED.has(lic));
if (bad.length) {
  for (const [lic, pkgs] of bad) console.error(`${lic}: ${pkgs.map((p) => p.name).join(', ')}`);
  process.exit(1);
}
console.log(`Licences OK: ${Object.keys(byLicense).join(', ')}`);
