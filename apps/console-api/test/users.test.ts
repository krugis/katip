// SPDX-License-Identifier: AGPL-3.0-only
// The Users API on real Postgres as katip_console, with the identity service stubbed.
// `pnpm test:users` runs it against real Keycloak.
import { randomUUID } from 'node:crypto';
import { migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { AppError, createLogger, Errors } from '@katip/shared';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApi } from '../src/app.js';
import { createVerifier } from '../src/auth.js';
import { parseCsv } from '../src/csv.js';
import type { IdentityClient } from '../src/identity.js';
import { DbConsoleStore } from '../src/stores.js';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const ISSUER = 'https://auth.test/realms/katip';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let store: DbConsoleStore;
let api: FastifyInstance;
let key: SigningKey;
let a: string;
let b: string;
let ownerId: string;
let otherId: string;

const calls: string[] = [];
let failInvite: AppError | null = null;
let failEmail = false;
let failEnabled = false;
const identity: IdentityClient = {
  invite: async (slug, input) => {
    calls.push(`invite ${slug} ${input.email} ${input.role}`);
    if (failInvite) throw failInvite;
    return { keycloakId: `kc-${randomUUID()}` };
  },
  sendInvite: async (slug, email) => {
    calls.push(`email ${slug} ${email}`);
    if (failEmail) throw new Error('smtp down');
  },
  setRole: async (slug, email, role) => {
    calls.push(`role ${slug} ${email} ${role}`);
  },
  setEnabled: async (slug, email, enabled) => {
    calls.push(`enabled ${slug} ${email} ${enabled}`);
    if (failEnabled) throw new AppError(502, 'identity_unavailable', 'no');
  },
};

const token = (email: string, organization: string, roles: string[] = ['tenant_admin']) =>
  new SignJWT({ realm_access: { roles }, organization: [organization], email })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('kc-user')
    .setIssuer(ISSUER)
    .setAudience('console-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);

const asOwner = () => token('owner@a.test', 'tenant-a');
const url = (tenant: string, rest = '') => `/api/v1/tenants/${tenant}/users${rest}`;
const send = async (
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  payload?: object | string,
  bearer?: string,
) =>
  api.inject({
    method,
    url: path,
    headers: {
      authorization: `Bearer ${bearer ?? (await asOwner())}`,
      ...(typeof payload === 'string' ? { 'content-type': 'text/csv' } : {}),
    },
    ...(payload === undefined ? {} : { payload }),
  });

const addTenant = async (slug: string, seats: number) => {
  const [t] = await admin`insert into tenants (slug, name, status, kvkk_addon)
    values (${slug}, ${slug}, 'active', false) returning id`;
  const id = t!['id'] as string;
  await admin`insert into seats (tenant_id, plan_code, quantity) values (${id}, 'business', ${seats})`;
  return id;
};
const addUser = async (tenant: string, email: string, role = 'user', status = 'active') => {
  const [u] =
    await admin`insert into users (tenant_id, keycloak_id, email, name, role, seat_plan_code, status)
    values (${tenant}, ${`kc-${email}`}, ${email}, ${email}, ${role}, 'business', ${status}) returning id`;
  return u!['id'] as string;
};
const audit = (tenant: string) =>
  admin`select action, actor_type, actor_id, target_id, details from audit_log where tenant_id = ${tenant} order by ts desc`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await seed(drizzle(admin, { schema }), { tenant: null });
  await admin.unsafe(`ALTER ROLE katip_console PASSWORD 'console-test-password'`);
  const dbUrl = new URL(container.getConnectionUri());
  dbUrl.username = 'katip_console';
  dbUrl.password = 'console-test-password';
  store = new DbConsoleStore(dbUrl.toString());

  const pair = await generateKeyPair('RS256', { extractable: true });
  key = pair.privateKey as SigningKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  api = await buildApi({
    store,
    identity,
    verifyToken: createVerifier({
      issuer: ISSUER,
      audience: 'console-api',
      keys: createLocalJWKSet({ keys: [jwk] }),
    }),
    logger: createLogger('test', { level: 'silent' }),
  });
}, 240_000);

afterAll(async () => {
  await api?.close();
  await store?.close();
  await admin?.end();
  await container?.stop();
});

beforeEach(async () => {
  calls.length = 0;
  failInvite = null;
  failEmail = false;
  failEnabled = false;
  await admin`truncate audit_log`;
  await admin`truncate tenants cascade`;
  a = await addTenant('tenant-a', 3);
  b = await addTenant('tenant-b', 3);
  ownerId = await addUser(a, 'owner@a.test', 'tenant_admin');
  otherId = await addUser(b, 'other@b.test');
});

describe('inviting', () => {
  it('adds the user, tells Keycloak, emails them and audits it', async () => {
    const res = await send('POST', url(a), {
      email: 'Ayse@A.test',
      name: 'Ayşe Yılmaz',
      role: 'dept_manager',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      email: 'ayse@a.test',
      name: 'Ayşe Yılmaz',
      role: 'dept_manager',
      status: 'active',
      seatPlanCode: 'business',
      invited: true,
    });
    expect(calls).toEqual([
      'invite tenant-a ayse@a.test dept_manager',
      'email tenant-a ayse@a.test',
    ]);
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'user.invite', actor_type: 'user', actor_id: ownerId });
    expect(JSON.stringify(entry)).not.toContain('ayse');
    expect(JSON.stringify(entry)).not.toContain('Ayşe');
  });

  it('refuses a duplicate, without touching Keycloak', async () => {
    const res = await send('POST', url(a), { email: 'owner@a.test', name: 'X' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('user_exists');
    expect(calls).toEqual([]);
  });

  it('stops at the seat limit', async () => {
    await send('POST', url(a), { email: 'one@a.test', name: 'One' });
    await send('POST', url(a), { email: 'two@a.test', name: 'Two' });
    calls.length = 0;
    const res = await send('POST', url(a), { email: 'three@a.test', name: 'Three' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('no_seats');
    expect(calls).toEqual([]);
  });

  it('does not let parallel invites go over the seat limit', async () => {
    const all = await Promise.all(
      ['p1', 'p2', 'p3', 'p4', 'p5'].map((n) =>
        send('POST', url(a), { email: `${n}@a.test`, name: n }),
      ),
    );
    expect(all.filter((r) => r.statusCode === 201)).toHaveLength(2);
    expect(all.filter((r) => r.statusCode === 409)).toHaveLength(3);
  });

  it('does not count disabled users as using a seat', async () => {
    await addUser(a, 'off1@a.test', 'user', 'disabled');
    await addUser(a, 'off2@a.test', 'user', 'disabled');
    await addUser(a, 'off3@a.test', 'user', 'disabled');
    const res = await send('POST', url(a), { email: 'new@a.test', name: 'New' });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a tier the company has no seats on', async () => {
    const res = await send('POST', url(a), {
      email: 'n@a.test',
      name: 'N',
      seatPlanCode: 'studio',
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("refuses another company's department", async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${b}, 'Sales') returning id`;
    const res = await send('POST', url(a), {
      email: 'n@a.test',
      name: 'N',
      departmentId: d!['id'],
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('adds no row when Keycloak refuses the email', async () => {
    failInvite = Errors.conflict('email_in_use', 'This email address cannot be invited');
    const res = await send('POST', url(a), { email: 'taken@a.test', name: 'T' });
    expect(res.statusCode).toBe(409);
    expect(await admin`select 1 from users where email = 'taken@a.test'`).toHaveLength(0);
  });

  it('keeps the user when only the email fails, and a resend works', async () => {
    failEmail = true;
    const res = await send('POST', url(a), { email: 'n@a.test', name: 'N' });
    expect(res.statusCode).toBe(201);
    expect(res.json().invited).toBe(false);
    failEmail = false;
    const again = await send('POST', url(a, `/${res.json().id}/invite`));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ invited: true });
  });

  it.each([
    ['a bad email', { email: 'nope', name: 'N' }],
    ['no name', { email: 'n@a.test', name: ' ' }],
    ['the provider role', { email: 'n@a.test', name: 'N', role: 'provider_admin' }],
  ])('refuses %s', async (_label, body) => {
    expect((await send('POST', url(a), body)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('listing', () => {
  it("shows only the company's own users", async () => {
    const res = await send('GET', url(a));
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((u: { email: string }) => u.email)).toEqual(['owner@a.test']);
  });
});

describe('changing a user', () => {
  it('disables them: Keycloak first, then the row', async () => {
    const id = await addUser(a, 'u@a.test');
    const res = await send('PATCH', url(a, `/${id}`), { status: 'disabled' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('disabled');
    expect(calls).toEqual(['enabled tenant-a u@a.test false']);
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'user.update', target_id: id });
    expect(entry!['details']).toEqual({ status: 'disabled' });
  });

  it('changes nothing if Keycloak fails', async () => {
    const id = await addUser(a, 'u@a.test');
    failEnabled = true;
    const res = await send('PATCH', url(a, `/${id}`), { status: 'disabled' });
    expect(res.statusCode).toBe(502);
    const [u] = await admin`select status from users where id = ${id}`;
    expect(u!['status']).toBe('active');
    expect(await audit(a)).toHaveLength(0);
  });

  it('changes the role in both places', async () => {
    const id = await addUser(a, 'u@a.test');
    const res = await send('PATCH', url(a, `/${id}`), { role: 'dept_manager' });
    expect(res.json().role).toBe('dept_manager');
    expect(calls).toEqual(['role tenant-a u@a.test dept_manager']);
  });

  it('does not call Keycloak for a name or tier', async () => {
    const id = await addUser(a, 'u@a.test');
    const res = await send('PATCH', url(a, `/${id}`), { name: 'Yeni Ad' });
    expect(res.json().name).toBe('Yeni Ad');
    expect(calls).toEqual([]);
    const [entry] = await audit(a);
    expect(JSON.stringify(entry)).not.toContain('Yeni');
  });

  it('refuses to re-enable when no seat is free', async () => {
    const id = await addUser(a, 'off@a.test', 'user', 'disabled');
    await addUser(a, 'u1@a.test');
    await addUser(a, 'u2@a.test');
    const res = await send('PATCH', url(a, `/${id}`), { status: 'active' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('no_seats');
    expect(calls).toEqual([]);
  });

  it.each([
    ['disable yourself', { status: 'disabled' }],
    ['change your own role', { role: 'user' }],
  ])('refuses to let you %s', async (_label, body) => {
    const res = await send('PATCH', url(a, `/${ownerId}`), body);
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('refuses to remove the last tenant admin, even for a provider admin', async () => {
    const provider = await token('staff@katip.test', 'provider', ['provider_admin']);
    for (const body of [{ status: 'disabled' }, { role: 'user' }]) {
      const res = await send('PATCH', url(a, `/${ownerId}`), body, provider);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('last_admin');
    }
    expect(calls).toEqual([]);
  });

  it('allows it when another admin remains', async () => {
    const second = await addUser(a, 'second@a.test', 'tenant_admin');
    const res = await send('PATCH', url(a, `/${second}`), { role: 'user' });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an empty change', async () => {
    const id = await addUser(a, 'u@a.test');
    expect((await send('PATCH', url(a, `/${id}`), {})).statusCode).toBe(400);
  });

  it('a disabled user is refused on their next request', async () => {
    const id = await addUser(a, 'u@a.test');
    const theirs = await token('u@a.test', 'tenant-a', ['user']);
    expect((await send('GET', '/api/v1/me', undefined, theirs)).statusCode).toBe(200);
    await send('PATCH', url(a, `/${id}`), { status: 'disabled' });
    const res = await send('GET', '/api/v1/me', undefined, theirs);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('user_disabled');
  });
});

describe('tenant isolation', () => {
  it("answers 404 for another company's users, on every route", async () => {
    for (const res of [
      await send('GET', url(b)),
      await send('POST', url(b), { email: 'x@b.test', name: 'X' }),
      await send('PATCH', url(b, `/${otherId}`), { status: 'disabled' }),
      await send('POST', url(b, `/${otherId}/invite`)),
      await send('POST', url(b, '/import'), 'email,name\nx@b.test,X\n'),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("can't reach another company's user through its own company's path", async () => {
    for (const res of [
      await send('PATCH', url(a, `/${otherId}`), { status: 'disabled' }),
      await send('POST', url(a, `/${otherId}/invite`)),
    ]) {
      expect(res.statusCode).toBe(404);
    }
    const [u] = await admin`select status from users where id = ${otherId}`;
    expect(u!['status']).toBe('active');
    expect(calls).toEqual([]);
  });

  it('the same email may exist in two companies only if Keycloak allows it', async () => {
    const res = await send('POST', url(a), { email: 'other@b.test', name: 'O' });
    expect(calls[0]).toBe('invite tenant-a other@b.test user');
    expect(res.statusCode).toBe(201);
  });
});

describe('the console role', () => {
  it.each([
    ['delete users', `delete from users`],
    ['change a user email', `update users set email = 'x'`],
    ['change a user tenant', `update users set tenant_id = null`],
    ['change seats', `update seats set quantity = 100`],
    ['read the audit log', `select * from audit_log`],
    ['rewrite the audit log', `update audit_log set action = 'x'`],
    ['change a tenant', `update tenants set status = 'active'`],
  ])('is denied: %s', async (_label, statement) => {
    const url_ = new URL(container.getConnectionUri());
    url_.username = 'katip_console';
    url_.password = 'console-test-password';
    const conn = postgres(url_.toString(), { max: 1 });
    await expect(conn.unsafe(statement)).rejects.toThrow(/permission denied/);
    await conn.end();
  });
});

describe('importing a CSV', () => {
  it('invites good rows, skips existing ones, and reports bad ones', async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${a}, 'Satış') returning id`;
    const res = await send(
      'POST',
      url(a, '/import'),
      [
        'email,name,department,tier',
        'ayse@a.test,"Yılmaz, Ayşe",Satış,business',
        'owner@a.test,Owner,,',
        'not-an-email,Bad,,',
        'x@a.test,X,Nowhere,',
      ].join('\n'),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      created: [{ row: 2, email: 'ayse@a.test', invited: true }],
      skipped: [{ row: 3, email: 'owner@a.test' }],
      failed: [
        { row: 4, email: 'not-an-email', reason: 'invalid_row' },
        { row: 5, email: 'x@a.test', reason: 'unknown_department' },
      ],
    });
    const [u] = await admin`select name, department_id from users where email = 'ayse@a.test'`;
    expect(u).toMatchObject({ name: 'Yılmaz, Ayşe', department_id: d!['id'] });
  });

  it('reports the rows past the seat limit', async () => {
    const res = await send(
      'POST',
      url(a, '/import'),
      'email,name\n1@a.test,A\n2@a.test,B\n3@a.test,C\n',
    );
    expect(res.json().created).toHaveLength(2);
    expect(res.json().failed).toEqual([{ row: 4, email: '3@a.test', reason: 'no_seats' }]);
  });

  it('refuses a file with no email column', async () => {
    const res = await send('POST', url(a, '/import'), 'name\nAyşe\n');
    expect(res.statusCode).toBe(400);
  });

  it('refuses too many rows', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => `u${i}@a.test,U`).join('\n');
    const res = await send('POST', url(a, '/import'), `email,name\n${rows}\n`);
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });
});

describe('parseCsv', () => {
  it('reads Excel on a Turkish system: semicolons, byte order mark, CRLF', () => {
    const { columns, rows } = parseCsv('\uFEFFEmail;Name\r\nayse@a.test;Ayşe\r\n\r\n');
    expect(columns).toEqual(['email', 'name']);
    expect(rows).toEqual([{ row: 2, values: { email: 'ayse@a.test', name: 'Ayşe' } }]);
  });

  it('reads quotes, escaped quotes, and commas and newlines inside them', () => {
    const { rows } = parseCsv('a,b\n"x,1","say ""hi"""\n"two\nlines",z');
    expect(rows[0]!.values).toEqual({ a: 'x,1', b: 'say "hi"' });
    expect(rows[1]!.values).toEqual({ a: 'two\nlines', b: 'z' });
  });

  it('copes with short rows and an empty file', () => {
    expect(parseCsv('a,b\n1\n').rows[0]!.values).toEqual({ a: '1', b: '' });
    expect(parseCsv('').rows).toEqual([]);
  });

  it('refuses an unclosed quote', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/not closed/);
  });
});
