// SPDX-License-Identifier: AGPL-3.0-only
// What the identity service refuses, and that it needs its token.
import { createLogger } from '@katip/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildIdentityServer } from '../src/identity-server.js';
import { TenantUsers, type IdentityDirectory, type TenantRole } from '../src/identity.js';

const TOKEN = 'a-long-enough-identity-token-for-tests';

interface FakeUser {
  id: string;
  email: string;
  orgs: string[];
  roles: string[];
  enabled: boolean;
  sessions: number;
}

let people: FakeUser[];
let invitesSent: string[];

const byId = (id: string) => people.find((p) => p.id === id)!;
const directory: IdentityDirectory = {
  findUser: async (email) => people.find((p) => p.email === email) ?? null,
  organizationsOf: async (id) => byId(id).orgs,
  realmRolesOf: async (id) => byId(id).roles,
  createInvitedUser: async ({ email }) => {
    const id = `kc-${people.length}`;
    people.push({ id, email, orgs: [], roles: [], enabled: true, sessions: 0 });
    return id;
  },
  grantMembership: async (slug, id) => {
    byId(id).orgs = [...new Set([...byId(id).orgs, slug])];
  },
  setRealmRole: async (id, role: TenantRole, all) => {
    const u = byId(id);
    u.roles = [...u.roles.filter((r) => !(all as readonly string[]).includes(r)), role];
  },
  setEnabled: async (id, enabled) => {
    byId(id).enabled = enabled;
  },
  endSessions: async (id) => {
    byId(id).sessions = 0;
  },
  sendInviteEmail: async (_slug, id) => {
    invitesSent.push(id);
  },
};

let app: FastifyInstance;
const call = (method: 'POST' | 'PUT' | 'GET', url: string, payload?: object, token = TOKEN) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

beforeAll(async () => {
  app = buildIdentityServer(
    new TenantUsers(directory),
    TOKEN,
    createLogger('test', { level: 'silent' }),
  );
  await app.ready();
});
afterAll(async () => app?.close());

beforeEach(() => {
  invitesSent = [];
  people = [
    { id: 'a', email: 'a@acme.test', orgs: ['acme'], roles: ['user'], enabled: true, sessions: 2 },
    { id: 'b', email: 'b@beta.test', orgs: ['beta'], roles: ['user'], enabled: true, sessions: 1 },
    {
      id: 'p',
      email: 'staff@katip.test',
      orgs: ['provider'],
      roles: ['provider_admin'],
      enabled: true,
      sessions: 1,
    },
    {
      id: 'x',
      email: 'wrong@acme.test',
      orgs: ['acme'],
      roles: ['provider_admin'],
      enabled: true,
      sessions: 1,
    },
    {
      id: 'two',
      email: 'two@acme.test',
      orgs: ['acme', 'beta'],
      roles: ['user'],
      enabled: true,
      sessions: 1,
    },
  ];
});

describe('its token', () => {
  it.each([
    ['none', ''],
    ['a wrong one', 'x'.repeat(TOKEN.length)],
    ['a short one', 'x'],
  ])('refuses %s', async (_label, token) => {
    const res = await call(
      'POST',
      '/v1/tenants/acme/users',
      { email: 'n@acme.test', name: 'N', role: 'user' },
      token,
    );
    expect(res.statusCode).toBe(401);
    expect(people.some((p) => p.email === 'n@acme.test')).toBe(false);
  });

  it('answers health without one', async () => {
    expect((await call('GET', '/healthz', undefined, '')).statusCode).toBe(200);
  });
});

describe('invite', () => {
  it('creates the login, in this company only, with the role', async () => {
    const res = await call('POST', '/v1/tenants/acme/users', {
      email: 'n@acme.test',
      name: 'N',
      role: 'dept_manager',
    });
    expect(res.statusCode).toBe(200);
    const made = people.find((p) => p.email === 'n@acme.test')!;
    expect(made.orgs).toEqual(['acme']);
    expect(made.roles).toEqual(['dept_manager']);
    expect(res.json()).toEqual({ keycloakId: made.id });
  });

  it('keeps the id of an existing login that has no other company', async () => {
    people.push({
      id: 'free',
      email: 'free@acme.test',
      orgs: [],
      roles: [],
      enabled: false,
      sessions: 0,
    });
    const res = await call('POST', '/v1/tenants/acme/users', {
      email: 'free@acme.test',
      name: 'F',
      role: 'user',
    });
    expect(res.json()).toEqual({ keycloakId: 'free' });
    expect(byId('free').enabled).toBe(true);
  });

  it.each([
    ['in another company', 'b@beta.test'],
    ['a provider admin', 'staff@katip.test'],
    ['holding the provider role', 'wrong@acme.test'],
  ])('refuses someone %s, and changes nothing', async (_label, email) => {
    const before = JSON.stringify(people);
    const res = await call('POST', '/v1/tenants/acme/users', { email, name: 'X', role: 'user' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'email_in_use' });
    expect(JSON.stringify(people)).toBe(before);
  });

  it.each(['provider_admin', 'admin', ''])('refuses the role %j', async (role) => {
    const res = await call('POST', '/v1/tenants/acme/users', {
      email: 'n@acme.test',
      name: 'N',
      role,
    });
    expect(res.statusCode).toBe(400);
  });

  it('refuses the provider organization', async () => {
    const res = await call('POST', '/v1/tenants/provider/users', {
      email: 'n@acme.test',
      name: 'N',
      role: 'user',
    });
    expect(res.statusCode).toBe(403);
    expect(people.some((p) => p.email === 'n@acme.test')).toBe(false);
  });
});

describe('role and enabled', () => {
  it('changes the role, and only among tenant roles', async () => {
    const res = await call('PUT', '/v1/tenants/acme/users/role', {
      email: 'a@acme.test',
      role: 'tenant_admin',
    });
    expect(res.statusCode).toBe(200);
    expect(byId('a').roles).toEqual(['tenant_admin']);
    const up = await call('PUT', '/v1/tenants/acme/users/role', {
      email: 'a@acme.test',
      role: 'provider_admin',
    });
    expect(up.statusCode).toBe(400);
  });

  it('disabling ends the sessions, and enabling leaves them', async () => {
    await call('PUT', '/v1/tenants/acme/users/enabled', { email: 'a@acme.test', enabled: false });
    expect(byId('a')).toMatchObject({ enabled: false, sessions: 0 });
    byId('a').sessions = 1;
    await call('PUT', '/v1/tenants/acme/users/enabled', { email: 'a@acme.test', enabled: true });
    expect(byId('a')).toMatchObject({ enabled: true, sessions: 1 });
  });

  it.each([
    ['another company', 'b@beta.test', 404],
    ['two companies', 'two@acme.test', 404],
    ['nobody', 'none@acme.test', 404],
    ['the provider', 'staff@katip.test', 404],
    ['this company, with the provider role', 'wrong@acme.test', 403],
  ])('refuses a user in %s, and changes nothing', async (_label, email, status) => {
    const before = JSON.stringify(people);
    for (const [path, body] of [
      ['enabled', { email, enabled: false }],
      ['role', { email, role: 'user' }],
    ] as const) {
      const res = await call('PUT', `/v1/tenants/acme/users/${path}`, body);
      expect(res.statusCode).toBe(status);
    }
    const res = await call('POST', '/v1/tenants/acme/users/send-invite', { email });
    expect(res.statusCode).toBe(status);
    expect(JSON.stringify(people)).toBe(before);
    expect(invitesSent).toEqual([]);
  });

  it('sends an invite to a member', async () => {
    const res = await call('POST', '/v1/tenants/acme/users/send-invite', { email: 'a@acme.test' });
    expect(res.statusCode).toBe(200);
    expect(invitesSent).toEqual(['a']);
  });

  it.each(['../admin', 'ab', 'Acme'])('refuses the slug %j', async (slug) => {
    const res = await call('PUT', `/v1/tenants/${encodeURIComponent(slug)}/users/enabled`, {
      email: 'a@acme.test',
      enabled: false,
    });
    expect(res.statusCode).toBe(400);
    expect(byId('a').enabled).toBe(true);
  });
});

describe('when Keycloak fails', () => {
  it('says so without its details', async () => {
    const failing = buildIdentityServer(
      new TenantUsers({
        ...directory,
        findUser: async () => {
          throw new Error('secret keycloak detail');
        },
      }),
      TOKEN,
      createLogger('test', { level: 'silent' }),
    );
    const res = await failing.inject({
      method: 'PUT',
      url: '/v1/tenants/acme/users/enabled',
      payload: { email: 'a@acme.test', enabled: false },
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('secret');
    await failing.close();
  });
});
