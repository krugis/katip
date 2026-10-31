// SPDX-License-Identifier: AGPL-3.0-only
// Fails if a TypeScript/JavaScript source file in apps/ or packages/ lacks the SPDX header.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = '// SPDX-License-Identifier: AGPL-3.0-only';
const roots = ['apps', 'packages', 'scripts'];
const skip = new Set(['node_modules', 'dist', 'coverage', '.turbo']);
const missing = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) {
      const first = readFileSync(p, 'utf8').split('\n', 1)[0];
      if (first.trim() !== HEADER) missing.push(p);
    }
  }
}
for (const r of roots) {
  try {
    walk(r);
  } catch {
    /* root may not exist yet */
  }
}
if (missing.length) {
  console.error(`Missing SPDX header in:\n${missing.join('\n')}`);
  process.exit(1);
}
console.log('SPDX headers OK');
