// SPDX-License-Identifier: AGPL-3.0-only
// The security gates' own pieces (P1-46, LLD-10 §6): the accepted-findings file, the image list
// the scans use, and the compose settings Trivy can't check, as it reads no compose files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_DAYS, allowlistProblems } from '../../security/check-trivyignore.mjs';
import { ourImages, thirdPartyImages } from '../../security/images.mjs';
import { loadConfig } from '../config.mjs';
import { INFRA, ROOT } from '../util.mjs';

describe('.trivyignore.yaml', () => {
  const today = new Date('2026-11-04T12:00:00Z');
  const entry = (fields) =>
    `vulnerabilities:\n  - id: CVE-2026-0001\n${Object.entries(fields)
      .map(([k, v]) => `    ${k}: ${v}`)
      .join('\n')}\n`;

  it('accepts an entry with a reason and a near expiry', () => {
    const text = entry({ statement: "'Not reachable: explained here.'", expired_at: '2026-12-01' });
    expect(allowlistProblems(text, today)).toEqual([]);
  });

  it('refuses an entry with no reason', () => {
    expect(allowlistProblems(entry({ expired_at: '2026-12-01' }), today)).toEqual([
      'vulnerabilities[0] CVE-2026-0001: no statement saying why it is accepted',
    ]);
  });

  it('refuses an entry with no expiry, or one too far ahead', () => {
    const statement = "'Not reachable: explained here.'";
    expect(allowlistProblems(entry({ statement }), today)[0]).toMatch(/expired_at must be a date/);
    expect(allowlistProblems(entry({ statement, expired_at: '2028-01-01' }), today)[0]).toMatch(
      new RegExp(`more than ${MAX_DAYS} days`),
    );
  });

  it('refuses an entry past its date, so it is renewed or removed', () => {
    const text = entry({ statement: "'Not reachable: explained here.'", expired_at: '2026-11-04' });
    expect(allowlistProblems(text, today)[0]).toMatch(/expired on 2026-11-04/);
  });

  it('refuses a section Trivy does not read', () => {
    expect(allowlistProblems('vulns: []\n', today)).toEqual(['vulns: not a section Trivy reads']);
  });

  it('is valid in the repository today', () => {
    const file = join(ROOT, '.trivyignore.yaml');
    expect(existsSync(file)).toBe(true);
    expect(allowlistProblems(readFileSync(file, 'utf8'))).toEqual([]);
  });
});

describe('images the scans cover', () => {
  const config = loadConfig();

  it('builds each of ours from a Dockerfile that exists', () => {
    for (const image of ourImages(config)) {
      expect(existsSync(join(ROOT, image.dockerfile)), image.dockerfile).toBe(true);
      for (const [k, v] of Object.entries(image.args)) expect(v, `${image.name} ${k}`).toBeTruthy();
    }
  });

  it('covers every Dockerfile in the repository', () => {
    const covered = ourImages(config).map((i) => i.dockerfile);
    for (const dir of [
      'apps/billing-bridge',
      'apps/console',
      'apps/console-api',
      'apps/mock-llm',
    ]) {
      expect(covered).toContain(`${dir}/Dockerfile`);
    }
    expect(covered).toEqual(
      expect.arrayContaining([
        'apps/policy-gateway/Dockerfile',
        'apps/provisioner/Dockerfile',
        'infra/litellm/Dockerfile',
        'infra/presidio/Dockerfile',
      ]),
    );
  });

  it('gates only the third-party pins a change touches', () => {
    const base = structuredClone(config);
    base.images.mongodb = 'mongo:7.0.1';
    delete base.images.mailpit;
    const changed = thirdPartyImages(config, base)
      .filter((i) => i.changed)
      .map((i) => i.name)
      .sort();
    expect(changed).toEqual(['mailpit', 'mongodb']);
    expect(thirdPartyImages(config).every((i) => !i.changed)).toBe(true);
  });
});

describe('compose files', () => {
  const files = ['platform.yml', 'dev.yml', 'billing.yml', 'tenant.tmpl.yml'];
  const read = (f) => readFileSync(join(INFRA, 'compose', f), 'utf8');

  it.each(files)('%s gives no container the host or Docker', (f) => {
    const text = read(f);
    for (const bad of [
      /^\s*privileged:\s*true/m,
      /network_mode:\s*['"]?host/,
      /^\s*pid:\s*['"]?host/m,
      /^\s*ipc:\s*['"]?host/m,
      /docker\.sock/,
      /^\s*cap_add:/m,
      /:latest\b/,
    ]) {
      expect(text, `${f} matches ${bad}`).not.toMatch(bad);
    }
  });

  it.each(files)('%s publishes ports only for Traefik, or on 127.0.0.1 in dev', (f) => {
    const lines = read(f).split('\n');
    const published = [];
    lines.forEach((line, i) => {
      if (!/^\s*ports:\s*$/.test(line)) return;
      const indent = line.search(/\S/);
      for (let j = i + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === '') continue;
        if (l.search(/\S/) <= indent) break;
        published.push(l.trim().replace(/^-\s*/, '').replace(/['"]/g, ''));
      }
    });
    for (const p of published) {
      const traefik = f === 'platform.yml' && ['80:80', '443:443'].includes(p);
      const localDev = f === 'dev.yml' && p.startsWith('127.0.0.1:');
      expect(traefik || localDev, `${f} publishes ${p}`).toBe(true);
    }
  });
});
