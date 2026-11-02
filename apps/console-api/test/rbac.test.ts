// SPDX-License-Identifier: AGPL-3.0-only
// RBAC matrix (LLD-04 §5): role × endpoint × own or other tenant. Every /api/v1 route must
// be in MATRIX, or this fails, so a new endpoint can't ship without its checks.
import { createLogger } from '@katip/shared';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApi } from '../src/app.js';
import { createVerifier, type Role } from '../src/auth.js';
import type { IdentityClient } from '../src/identity.js';
import type { ConsoleStore, ManagedUser, TenantRecord, UserRecord } from '../src/stores.js';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const ISSUER = 'https://auth.test/realms/katip';
const AUDIENCE = 'console-api';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SUSPENDED = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

const tenants: TenantRecord[] = [
  { id: A, slug: 'acme', name: 'Acme', status: 'active' },
  { id: B, slug: 'beta', name: 'Beta', status: 'active' },
  { id: SUSPENDED, slug: 'gone', name: 'Gone', status: 'suspended' },
];
const user = (email: string, status = 'active'): UserRecord => ({
  id: USER_ID,
  email,
  name: 'Ayşe',
  role: 'user',
  status,
});
const managed: ManagedUser = {
  ...user('ayse@acme.test'),
  departmentId: null,
  seatPlanCode: 'business',
  lastSeenAt: null,
};
const policyDocument = {
  aliases: { auto: true, fast: true, best: true, 'tr-local': false },
  allowUserModelChoice: false,
  allowedModels: [],
  atQuotaLimit: 'downgrade' as const,
  residency: 'ANY_APPROVED' as const,
  pii: { mode: 'mask' as const },
};
const ownRequest = {
  id: USER_ID,
  type: 'model',
  reason: 'r',
  status: 'pending',
  createdAt: new Date(0).toISOString(),
  decidedAt: null,
};
const privacyRequest = {
  id: USER_ID,
  type: 'delete',
  status: 'pending',
  createdAt: new Date(0).toISOString(),
  completedAt: null,
};
const accessView = {
  ipAllowlist: [],
  countries: ['TR'],
  mfaRequired: true,
  sessionIdleMin: 30,
  sessionMaxH: 10,
};
const policyView = { policy: policyDocument, version: 1, kvkkAddon: false, catalog: [] };
const department = {
  id: USER_ID,
  name: 'Sales',
  budgetUsdMicro: null,
  managerIds: [],
  userCount: 0,
};
const identity: IdentityClient = {
  invite: async () => ({ keycloakId: 'kc' }),
  sendInvite: async () => undefined,
  setRole: async () => undefined,
  setEnabled: async () => undefined,
  setSessionLimits: async () => undefined,
};
const store: ConsoleStore = {
  overview: async () => ({
    month: '202611',
    seats: [],
    limits: null,
    used: { standard: 0, premium: 0, research: 0 },
    alerts: [],
  }),
  recordAlerts: async () => false,
  listDepartments: async () => [],
  usage: async () => [],
  auditPage: async () => ({ entries: [], next: null }),
  auditAcrossTenants: async () => ({ entries: [], next: null }),
  ownRequests: async () => [],
  createRequest: async () => ownRequest,
  allRequests: async () => [],
  ownPrivacyRequests: async () => [],
  allPrivacyRequests: async () => [],
  exportOwnData: async () => ({}),
  requestDeletion: async () => privacyRequest,
  completePrivacyRequest: async () => privacyRequest,
  canSeeDepartment: async () => true,
  departmentUsers: async () => [],
  departmentRequests: async () => [],
  decideRequest: async () => ({
    id: USER_ID,
    type: 'model',
    reason: '',
    status: 'approved',
    userName: 'A',
    userEmail: 'a@acme.test',
    createdAt: new Date(0).toISOString(),
    decidedAt: new Date(0).toISOString(),
  }),
  policy: async () => policyView,
  accessRules: async () => accessView,
  saveAccessRules: async () => accessView,
  allIpAllowlists: async () => [],
  savePolicy: async () => policyView,
  createDepartment: async () => department,
  updateDepartment: async () => department,
  startImport: async () => USER_ID,
  recordImport: async () => undefined,
  failImport: async () => undefined,
  importJob: async () => ({
    id: USER_ID,
    status: 'done',
    total: 0,
    created: 0,
    skipped: 0,
    notInvited: 0,
    failed: [],
  }),
  listUsers: async () => [managed],
  userById: async () => managed,
  departmentIdByName: async () => null,
  createUser: async () => managed,
  updateUser: async () => managed,
  tenantBySlug: async (slug) => tenants.find((t) => t.slug === slug) ?? null,
  tenantById: async (id) => tenants.find((t) => t.id === id) ?? null,
  listTenants: async () => tenants,
  findUser: async (tenantId, email) => {
    if (tenantId !== A && tenantId !== SUSPENDED) return null;
    if (email === 'off@acme.test') return user(email, 'disabled');
    return email.endsWith('@acme.test') ? user(email) : null;
  },
  ready: async () => true,
};

let privateKey: SigningKey;
let otherKey: SigningKey;
let api: FastifyInstance;

interface TokenOptions {
  roles?: string[];
  organization?: unknown;
  email?: string | null;
  issuer?: string;
  audience?: string;
  expires?: string;
  key?: SigningKey;
}

const token = (o: TokenOptions = {}) =>
  new SignJWT({
    realm_access: { roles: o.roles ?? ['user'] },
    organization: o.organization ?? ['acme'],
    ...(o.email === null ? {} : { email: o.email ?? 'ayse@acme.test' }),
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('kc-user')
    .setIssuer(o.issuer ?? ISSUER)
    .setAudience(o.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(o.expires ?? '5m')
    .sign(o.key ?? privateKey);

const get = (url: string, bearer?: string) =>
  api.inject({
    method: 'GET',
    url,
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });

const call = (row: (typeof MATRIX)[number], url: string, bearer?: string) =>
  api.inject({
    method: row.method ?? 'GET',
    url,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(typeof row.body === 'string' ? { 'content-type': 'text/csv' } : {}),
    },
    ...(row.body === undefined ? {} : { payload: row.body }),
  });

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey as SigningKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as SigningKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  api = await buildApi({
    store,
    identity,
    verifyToken: createVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: createLocalJWKSet({ keys: [jwk] }),
    }),
    logger: createLogger('test', { level: 'silent' }),
  });
});
afterAll(async () => api?.close());

type Who = Role | 'none';
const asRole = (role: Who): TokenOptions =>
  role === 'provider_admin'
    ? { roles: ['provider_admin'], organization: ['provider'] }
    : { roles: role === 'none' ? [] : [role] };

/** Expected status for each role, on own tenant and another tenant's. */
const ADMIN_ONLY = { dept_manager: 403, user: 403, none: 403 };
const EVERYONE = { tenant_admin: 200, dept_manager: 200, user: 200, none: 200 };
const MANAGERS = { tenant_admin: 200, dept_manager: 200, user: 403, none: 403 };
const OTHER_TENANT = { tenant_admin: 404, dept_manager: 404, user: 404, none: 404 };
const MATRIX: {
  route: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: object | string;
  url: (tenant: string) => string;
  own: Record<Who, number>;
  other?: Record<Who, number>;
}[] = [
  {
    route: '/api/v1/me',
    url: () => '/api/v1/me',
    own: { provider_admin: 200, tenant_admin: 200, dept_manager: 200, user: 200, none: 200 },
  },
  {
    route: '/api/v1/tenants/:tid',
    url: (t) => `/api/v1/tenants/${t}`,
    own: { provider_admin: 200, tenant_admin: 200, dept_manager: 403, user: 403, none: 403 },
    other: { provider_admin: 200, tenant_admin: 404, dept_manager: 404, user: 404, none: 404 },
  },
  {
    route: '/api/v1/admin/tenants',
    url: () => '/api/v1/admin/tenants',
    own: { provider_admin: 200, tenant_admin: 403, dept_manager: 403, user: 403, none: 403 },
  },
  {
    route: '/api/v1/tenants/:tid/users',
    url: (t) => `/api/v1/tenants/${t}/users`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/users',
    method: 'POST',
    body: { email: 'new@acme.test', name: 'New' },
    url: (t) => `/api/v1/tenants/${t}/users`,
    own: { provider_admin: 201, tenant_admin: 201, ...ADMIN_ONLY },
    other: { provider_admin: 201, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/users/:uid',
    method: 'PATCH',
    body: { name: 'New name' },
    url: (t) => `/api/v1/tenants/${t}/users/${USER_ID}`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/users/:uid/invite',
    method: 'POST',
    url: (t) => `/api/v1/tenants/${t}/users/${USER_ID}/invite`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/users/import',
    method: 'POST',
    body: 'email,name\n',
    url: (t) => `/api/v1/tenants/${t}/users/import`,
    own: { provider_admin: 202, tenant_admin: 202, ...ADMIN_ONLY },
    other: { provider_admin: 202, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/users/imports/:jid',
    url: (t) => `/api/v1/tenants/${t}/users/imports/${USER_ID}`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/policy',
    url: (t) => `/api/v1/tenants/${t}/policy`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/policy',
    method: 'PUT',
    body: { policy: policyDocument, version: 1 },
    url: (t) => `/api/v1/tenants/${t}/policy`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/access-rules',
    url: (t) => `/api/v1/tenants/${t}/access-rules`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/access-rules',
    method: 'PUT',
    body: { ipAllowlist: [], countries: ['TR'], sessionIdleMin: 30, sessionMaxH: 10 },
    url: (t) => `/api/v1/tenants/${t}/access-rules`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/usage',
    url: (t) => `/api/v1/tenants/${t}/usage`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/usage/export',
    url: (t) => `/api/v1/tenants/${t}/usage/export`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  ...[
    ['my-departments', '/api/v1/tenants/:tid/my-departments', 'my-departments'],
    ['users', '/api/v1/tenants/:tid/departments/:did/users', `departments/${USER_ID}/users`],
    ['usage', '/api/v1/tenants/:tid/departments/:did/usage', `departments/${USER_ID}/usage`],
    [
      'usage/export',
      '/api/v1/tenants/:tid/departments/:did/usage/export',
      `departments/${USER_ID}/usage/export`,
    ],
    [
      'requests',
      '/api/v1/tenants/:tid/departments/:did/requests',
      `departments/${USER_ID}/requests`,
    ],
  ].map(([, route, path]) => ({
    route: route!,
    url: (t: string) => `/api/v1/tenants/${t}/${path}`,
    own: { provider_admin: 200, ...MANAGERS },
    other: { provider_admin: 200, ...OTHER_TENANT },
  })),
  {
    route: '/api/v1/tenants/:tid/departments/:did/requests/:rid',
    method: 'PATCH',
    body: { status: 'approved' },
    url: (t) => `/api/v1/tenants/${t}/departments/${USER_ID}/requests/${USER_ID}`,
    own: { provider_admin: 200, ...MANAGERS },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/me/usage',
    url: () => '/api/v1/me/usage',
    own: { provider_admin: 403, ...EVERYONE },
  },
  {
    route: '/api/v1/me/requests',
    url: () => '/api/v1/me/requests',
    own: { provider_admin: 403, ...EVERYONE },
  },
  {
    route: '/api/v1/me/requests',
    method: 'POST',
    body: { type: 'model', reason: 'r' },
    url: () => '/api/v1/me/requests',
    own: {
      provider_admin: 403,
      tenant_admin: 201,
      dept_manager: 201,
      user: 201,
      none: 201,
    },
  },
  {
    route: '/api/v1/me/privacy',
    url: () => '/api/v1/me/privacy',
    own: { provider_admin: 403, ...EVERYONE },
  },
  {
    route: '/api/v1/me/privacy/export',
    method: 'POST',
    url: () => '/api/v1/me/privacy/export',
    own: { provider_admin: 403, ...EVERYONE },
  },
  {
    route: '/api/v1/me/privacy/delete',
    method: 'POST',
    url: () => '/api/v1/me/privacy/delete',
    own: {
      provider_admin: 403,
      tenant_admin: 201,
      dept_manager: 201,
      user: 201,
      none: 201,
    },
  },
  {
    route: '/api/v1/tenants/:tid/requests',
    url: (t) => `/api/v1/tenants/${t}/requests`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/requests/:rid',
    method: 'PATCH',
    body: { status: 'approved' },
    url: (t) => `/api/v1/tenants/${t}/requests/${USER_ID}`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/privacy-requests/:pid',
    method: 'PATCH',
    body: { status: 'completed' },
    url: (t) => `/api/v1/tenants/${t}/privacy-requests/${USER_ID}`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/audit',
    url: (t) => `/api/v1/tenants/${t}/audit`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/admin/audit',
    url: () => '/api/v1/admin/audit',
    own: { provider_admin: 200, tenant_admin: 403, dept_manager: 403, user: 403, none: 403 },
  },
  {
    route: '/api/v1/tenants/:tid/overview',
    url: (t) => `/api/v1/tenants/${t}/overview`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/departments',
    url: (t) => `/api/v1/tenants/${t}/departments`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/departments',
    method: 'POST',
    body: { name: 'Sales' },
    url: (t) => `/api/v1/tenants/${t}/departments`,
    own: { provider_admin: 201, tenant_admin: 201, ...ADMIN_ONLY },
    other: { provider_admin: 201, ...OTHER_TENANT },
  },
  {
    route: '/api/v1/tenants/:tid/departments/:did',
    method: 'PATCH',
    body: { name: 'Sales 2' },
    url: (t) => `/api/v1/tenants/${t}/departments/${USER_ID}`,
    own: { provider_admin: 200, tenant_admin: 200, ...ADMIN_ONLY },
    other: { provider_admin: 200, ...OTHER_TENANT },
  },
];

describe('RBAC matrix', () => {
  it('covers every /api/v1 route', () => {
    const declared = new Set(MATRIX.map((m) => m.route));
    const swagger = api.swagger() as { paths?: Record<string, unknown> };
    const documented = Object.keys(swagger.paths ?? {}).map((p) => p.replace(/\{(\w+)\}/g, ':$1'));
    expect(documented.sort()).toEqual([...declared].sort());
  });

  for (const row of MATRIX) {
    for (const role of Object.keys(row.own) as Who[]) {
      const label = `${row.method ?? 'GET'} ${row.route}`;
      it(`${label} as ${role}, own tenant → ${row.own[role]}`, async () => {
        const res = await call(row, row.url(A), await token(asRole(role)));
        expect(res.statusCode).toBe(row.own[role]);
      });
      it(`${label} with no token → 401`, async () => {
        expect((await call(row, row.url(A))).statusCode).toBe(401);
      });
      if (row.other) {
        const expected = row.other[role];
        it(`${label} as ${role}, other tenant → ${expected}`, async () => {
          const res = await call(row, row.url(B), await token(asRole(role)));
          expect(res.statusCode).toBe(expected);
        });
      }
    }
  }
});

describe('tokens', () => {
  it.each<[string, () => Promise<string>]>([
    ['another issuer', () => token({ issuer: 'https://evil.test/realms/katip' })],
    ['another audience', () => token({ audience: 'account' })],
    ['expired', () => token({ expires: '-1m' })],
    ['signed with another key', () => token({ key: otherKey })],
    ['garbage', async () => 'not.a.token'],
    [
      'unsigned',
      async () => {
        const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const claims = { sub: 'x', iss: ISSUER, aud: AUDIENCE, exp: 9999999999 };
        return `${part({ alg: 'none' })}.${part(claims)}.`;
      },
    ],
  ])('rejects %s', async (_label, make) => {
    const res = await get('/api/v1/me', await make());
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });
});

describe('who a token can be', () => {
  it('a provider_admin role without the provider organization is not a provider admin', async () => {
    const t = await token({ roles: ['provider_admin'], organization: ['acme'] });
    expect((await get('/api/v1/admin/tenants', t)).statusCode).toBe(403);
    expect((await get(`/api/v1/tenants/${B}`, t)).statusCode).toBe(404);
  });

  it('the provider organization without the role is not one either', async () => {
    const t = await token({ roles: ['user'], organization: ['provider'] });
    expect((await get('/api/v1/admin/tenants', t)).statusCode).toBe(403);
  });

  it.each<[string, TokenOptions, number, string]>([
    ['no organization', { organization: [] }, 403, 'forbidden'],
    ['two organizations', { organization: ['acme', 'beta'] }, 403, 'forbidden'],
    ['an unknown organization', { organization: ['nope'] }, 403, 'forbidden'],
    ['a suspended company', { organization: ['gone'] }, 403, 'forbidden'],
    ['no email', { email: null }, 403, 'user_not_provisioned'],
    ['a user not in the company', { email: 'x@beta.test' }, 403, 'user_not_provisioned'],
    ['a disabled user', { email: 'off@acme.test' }, 403, 'user_disabled'],
  ])('refuses %s', async (_label, options, status, code) => {
    const res = await get('/api/v1/me', await token(options));
    expect(res.statusCode).toBe(status);
    expect(res.json().code).toBe(code);
  });

  it('reads the organization claim when Keycloak sends it as a map', async () => {
    const res = await get('/api/v1/me', await token({ organization: { acme: { id: 'x' } } }));
    expect(res.statusCode).toBe(200);
    expect(res.json().tenant.slug).toBe('acme');
  });

  it('/me says who the caller is', async () => {
    const res = await get('/api/v1/me', await token({ roles: ['tenant_admin'] }));
    expect(res.json()).toMatchObject({
      roles: ['tenant_admin'],
      tenant: { id: A, slug: 'acme' },
      user: { id: USER_ID, email: 'ayse@acme.test' },
    });
    const provider = await get('/api/v1/me', await token(asRole('provider_admin')));
    expect(provider.json()).toEqual({ roles: ['provider_admin'], tenant: null, user: null });
  });
});

describe('errors are RFC 9457 problem+json', () => {
  it.each([
    ['401', '/api/v1/me', undefined, 401, 'unauthorized'],
    ['404, unknown route', '/api/v1/nope', undefined, 404, 'not_found'],
  ])('%s', async (_label, url, bearer, status, code) => {
    const res = await get(url, bearer);
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status, code, type: expect.stringContaining(code) });
  });

  it('403 and a bad parameter too', async () => {
    const forbidden = await get('/api/v1/admin/tenants', await token());
    expect(forbidden.headers['content-type']).toContain('application/problem+json');
    const bad = await get('/api/v1/tenants/not-a-uuid', await token(asRole('provider_admin')));
    expect(bad.statusCode).toBe(400);
    expect(bad.headers['content-type']).toContain('application/problem+json');
  });

  it('a provider admin asking for an unknown company gets 404', async () => {
    const unknown = '55555555-5555-4555-8555-555555555555';
    const res = await get(`/api/v1/tenants/${unknown}`, await token(asRole('provider_admin')));
    expect(res.statusCode).toBe(404);
  });
});

describe('OpenAPI', () => {
  it('is generated from the routes, and describes their security', async () => {
    const res = await get('/api/v1/openapi.json');
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.paths['/api/v1/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/v1/tenants/{tid}'].get.parameters[0].name).toBe('tid');
    expect(doc.paths['/healthz']).toBeUndefined();
  });
});

describe('deny by default', () => {
  it('a route that does not declare its access stops the server starting', async () => {
    await expect(
      buildApi({
        store,
        identity,
        verifyToken: async () => ({}),
        logger: createLogger('test', { level: 'silent' }),
        extraRoutes: (app) => {
          app.get('/api/v1/oops', async () => ({}));
        },
      }),
    ).rejects.toThrow(/GET \/api\/v1\/oops does not declare its access/);
  });
});

describe('health', () => {
  it('needs no token', async () => {
    expect((await get('/healthz')).statusCode).toBe(200);
    expect((await get('/readyz')).statusCode).toBe(200);
  });
});
