// SPDX-License-Identifier: AGPL-3.0-only
// What Traefik's HTTP provider reads. The status filter is in users.test.ts, on real Postgres.
import { describe, expect, it } from 'vitest';
import { routableSlug, traefikConfig } from '../src/access.js';

const http = (rules: { slug: string; ipAllowlist: string[] }[]) => {
  const { routers = {}, services = {}, middlewares } = traefikConfig(rules, 'katip.test').http;
  return { routers, services, middlewares };
};

describe('the routes given to Traefik', () => {
  it('gives a company what its labels did', () => {
    expect(http([{ slug: 'acme', ipAllowlist: ['198.51.100.0/24'] }])).toEqual({
      routers: {
        acme: {
          rule: 'Host(`acme.katip.test`)',
          entryPoints: ['websecure'],
          tls: {},
          middlewares: ['acme-ipallow@http', 'ratelimit-user@file', 'secure-headers@file'],
          service: 'acme',
        },
      },
      services: { acme: { loadBalancer: { servers: [{ url: 'http://lc-acme:3080' }] } } },
      middlewares: {
        'never-empty': { ipAllowList: { sourceRange: ['127.0.0.1/32'] } },
        'acme-ipallow': { ipAllowList: { sourceRange: ['198.51.100.0/24'] } },
      },
    });
  });

  it('never opens a route without its allowlist, whichever the order', () => {
    const { routers, middlewares } = http([
      { slug: 'acme', ipAllowlist: [] },
      { slug: 'beta', ipAllowlist: ['203.0.113.7/32'] },
    ]);
    for (const [slug, router] of Object.entries(routers)) {
      expect(router.middlewares[0]).toBe(`${slug}-ipallow@http`);
      expect(middlewares[`${slug}-ipallow`]).toBeDefined();
    }
    expect(middlewares['acme-ipallow']?.ipAllowList.sourceRange).toEqual(['0.0.0.0/0', '::/0']);
  });

  it("keeps each company's address and list to its own router", () => {
    const { routers, services, middlewares } = http([
      { slug: 'acme', ipAllowlist: ['198.51.100.0/24'] },
      { slug: 'beta', ipAllowlist: ['203.0.113.7/32'] },
    ]);
    const acme = JSON.stringify([routers['acme'], services['acme'], middlewares['acme-ipallow']]);
    expect(acme).not.toContain('beta');
    expect(acme).not.toContain('203.0.113.7');
    expect(JSON.stringify(routers['beta'])).not.toContain('acme');
  });

  it('holds nothing but hosts, addresses and names', () => {
    const rules = [{ slug: 'acme', ipAllowlist: [], name: 'ACME A.Ş.', id: 'id-1', email: 'x@y' }];
    const text = JSON.stringify(http(rules));
    for (const field of ['ACME', 'id-1', 'x@y']) expect(text).not.toContain(field);
  });

  it("still changes Traefik's config with no companies left", () => {
    // Traefik ignores an empty answer, and refuses `routers: {}` or `services: {}`. Either way
    // it would keep the last company's route. Tried on the real image.
    expect(traefikConfig([], 'katip.test').http).toEqual({
      middlewares: { 'never-empty': { ipAllowList: { sourceRange: ['127.0.0.1/32'] } } },
    });
  });

  it.each([
    ['a backtick, which would end the rule', 'a`) || Host(`evil.test'],
    ['a space', 'acme corp'],
    ['a dot, which would make another host', 'acme.evil'],
    ['a capital', 'ACME'],
    ['a slash', 'ac/me'],
    ['a line break at the end', 'acme\n'],
    ['too short', 'ab'],
    ['too long', 'a'.repeat(33)],
    ['nothing', ''],
    ['the login host', 'auth'],
    ['the console host', 'console'],
    ['the mail host', 'mailpit'],
  ])('gives no route to a slug with %s', (_label, slug) => {
    expect(routableSlug(slug)).toBe(false);
    const result = http([
      { slug, ipAllowlist: [] },
      { slug: 'acme', ipAllowlist: [] },
    ]);
    expect(Object.keys(result.routers)).toEqual(['acme']);
    expect(Object.keys(result.services)).toEqual(['acme']);
    expect(Object.keys(result.middlewares)).toEqual(['never-empty', 'acme-ipallow']);
  });

  it.each([['acme'], ['acme-2'], ['123'], ['a'.repeat(32)]])('routes %s', (slug) => {
    expect(routableSlug(slug)).toBe(true);
  });
});
