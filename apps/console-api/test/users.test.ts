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
import { checkAlerts, type Mail, type Mailer } from '../src/alerts.js';
import { addressRefused, chatNoticeMail, sendChatNotices } from '../src/chat-notice.js';
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
const announced: string[] = [];
let failAnnounce = false;
let failInvite: AppError | null = null;
let failEmail = false;
let failEnabled = false;
let failLimits = false;
const identity: IdentityClient = {
  setSessionLimits: async (slug, idle, max) => {
    calls.push(`limits ${slug} ${idle} ${max}`);
    if (failLimits) throw new AppError(502, 'identity_unavailable', 'no');
  },
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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
    events: {
      publish: async (channel, message) => {
        if (failAnnounce) throw new Error('valkey down');
        announced.push(`${channel} ${message}`);
        return 1;
      },
    },
    verifyToken: createVerifier({
      issuer: ISSUER,
      audience: 'console-api',
      keys: createLocalJWKSet({ keys: [jwk] }),
    }),
    logger: createLogger('test', { level: 'silent' }),
    baseDomain: 'katip.test',
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
  failLimits = false;
  announced.length = 0;
  failAnnounce = false;
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
    ['read provider cost', `select cost_usd_micro from usage_events`],
    ['read list price', `select price_usd_micro from usage_events`],
    ['read daily cost', `select cost_usd_micro from usage_daily`],
    ['rewrite a request', `update requests set payload = '{}'`],
    ['delete a request', `delete from requests`],
    ['delete a privacy request', `delete from privacy_requests`],
    ['write daily usage', `delete from usage_daily`],
    ['read model prices', `select price_in_usd_micro_per_m from model_catalog`],
    ['change the catalog', `update model_catalog set enabled = false`],
    ['rewrite policy history', `update policy_history set version = 0`],
    ['delete a policy', `delete from tenant_policies`],
    ['turn MFA off', `update access_rules set mfa_required = false`],
    ['read conversation ids', `select conversation_id from usage_events`],
    ['read who used what', `select user_id from usage_events`],
    ['change limits', `update tenant_limits set std_tokens = 1`],
    ['forget an alert', `delete from budget_alerts`],
    ['forget who was told of a notice', `delete from chat_retention_notice_recipients`],
    [
      'rewrite who was told of a notice',
      `update chat_retention_notice_recipients set user_id = null`,
    ],
    ['delete the state of chat retention', `delete from chat_retention_state`],
    [
      'move a chat retention state to another company',
      `update chat_retention_state set tenant_id = null`,
    ],
    ['delete departments', `delete from departments`],
    ['read gateway keys', `select * from gateway_keys`],
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

/** Starts an import and waits for it to finish. */
const importCsv = async (csv: string) => {
  const started = await send('POST', url(a, '/import'), csv);
  expect(started.statusCode).toBe(202);
  const { id, total } = started.json();
  for (let i = 0; i < 100; i += 1) {
    const res = await send('GET', url(a, `/imports/${id}`));
    if (res.json().status !== 'running') return { ...res.json(), id, total };
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the import did not finish');
};

describe('importing a CSV', () => {
  it('invites good rows in the background, skips existing ones, and reports bad ones', async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${a}, 'Satış') returning id`;
    const job = await importCsv(
      [
        'email,name,department,tier',
        'ayse@a.test,"Yılmaz, Ayşe",Satış,business',
        'owner@a.test,Owner,,',
        'not-an-email,Bad,,',
        'x@a.test,X,Nowhere,',
      ].join('\n'),
    );
    expect(job).toMatchObject({
      status: 'done',
      total: 4,
      created: 1,
      skipped: 1,
      notInvited: 0,
      failed: [
        { row: 4, reason: 'invalid_row' },
        { row: 5, reason: 'unknown_department' },
      ],
    });
    const [u] = await admin`select name, department_id from users where email = 'ayse@a.test'`;
    expect(u).toMatchObject({ name: 'Yılmaz, Ayşe', department_id: d!['id'] });
  });

  it('keeps no addresses in the job', async () => {
    const job = await importCsv('email,name\nayse@a.test,Ayşe Yılmaz\nnot-an-email,Bad\n');
    const [row] = await admin`select payload, result from jobs where id = ${job.id}`;
    const text = JSON.stringify(row);
    expect(text).not.toContain('ayse');
    expect(text).not.toContain('Yılmaz');
    expect(text).not.toContain('not-an-email');
  });

  it('reports the rows past the seat limit', async () => {
    const job = await importCsv('email,name\n1@a.test,A\n2@a.test,B\n3@a.test,C\n');
    expect(job.created).toBe(2);
    expect(job.failed).toEqual([{ row: 4, reason: 'no_seats' }]);
  });

  it('counts an invite whose email failed', async () => {
    failEmail = true;
    const job = await importCsv('email,name\n1@a.test,A\n');
    expect(job).toMatchObject({ created: 1, notInvited: 1 });
  });

  it('refuses a second import while one is running', async () => {
    await admin`insert into jobs (type, tenant_id, status, result)
      values ('users.import', ${a}, 'running', '{}'::jsonb)`;
    const res = await send('POST', url(a, '/import'), 'email,name\n1@a.test,A\n');
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('import_running');
  });

  it('calls a running import that stopped moving interrupted, and allows another', async () => {
    const [job] = await admin`insert into jobs (type, tenant_id, status, result, updated_at)
      values ('users.import', ${a}, 'running', ${JSON.stringify({ total: 3, created: 1, skipped: 0, notInvited: 0, failed: [] })}::jsonb, now() - interval '10 minutes')
      returning id`;
    const res = await send('GET', url(a, `/imports/${job!['id']}`));
    expect(res.json().status).toBe('interrupted');
    // Waits for it, or it would still be writing when the next test clears the tables.
    expect((await importCsv('email,name\n1@a.test,A\n')).status).toBe('done');
  });

  it("answers 404 for another company's import", async () => {
    const [job] = await admin`insert into jobs (type, tenant_id, status, result)
      values ('users.import', ${b}, 'done', '{}'::jsonb) returning id`;
    expect((await send('GET', url(a, `/imports/${job!['id']}`))).statusCode).toBe(404);
    expect((await send('GET', url(b, `/imports/${job!['id']}`))).statusCode).toBe(404);
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

describe('the overview', () => {
  const overview = (tenant: string) => send('GET', `/api/v1/tenants/${tenant}/overview`);
  const month = new Date().toISOString().slice(0, 7).replace('-', '');

  const addUsage = async (
    tenant: string,
    cls: string,
    source: string,
    tokens: number,
    ts = 'now()',
  ) =>
    admin.unsafe(
      `insert into usage_events (id, tenant_id, user_id, ts, alias, model_id, class, input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source)
       values ('${randomUUID()}', '${tenant}', '${randomUUID()}', ${ts}, 'fast', 'm', '${cls}', ${tokens}, ${tokens}, 999, 999, '${source}')`,
    );

  it('shows seats used, not counting the disabled', async () => {
    await addUser(a, 'u@a.test');
    await addUser(a, 'off@a.test', 'user', 'disabled');
    const res = await overview(a);
    expect(res.statusCode).toBe(200);
    expect(res.json().seats).toEqual([{ planCode: 'business', quantity: 3, used: 2 }]);
  });

  it("counts this month's tokens as the gateway does", async () => {
    await admin`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
      values (${a}, ${month}, 1000, 500, 10)`;
    await addUsage(a, 'standard', 'chat', 10);
    await addUsage(a, 'tr', 'chat', 5);
    await addUsage(a, 'premium', 'chat', 7);
    await addUsage(a, 'standard', 'research', 1);
    await addUsage(a, 'standard', 'chat', 1000, `now() - interval '45 days'`);
    await addUsage(b, 'standard', 'chat', 1000);
    expect((await overview(a)).json()).toMatchObject({
      month,
      limits: { standard: 1000, premium: 500, research: 10 },
      used: { standard: 32, premium: 14, research: 1 },
    });
  });

  it('never carries cost, which is our margin', async () => {
    await addUsage(a, 'standard', 'chat', 10);
    expect((await overview(a)).body).not.toContain('999');
    expect((await overview(a)).body).not.toMatch(/cost|price/i);
  });

  it('copes with no limits yet', async () => {
    const body = (await overview(a)).json();
    expect(body.limits).toBeNull();
    expect(body.used).toEqual({ standard: 0, premium: 0, research: 0 });
  });
});

describe('departments', () => {
  const path = (tenant: string, rest = '') => `/api/v1/tenants/${tenant}/departments${rest}`;
  const make = async (name = 'Satış', budgetUsdMicro: number | null = 50_000_000) =>
    (await send('POST', path(a), { name, budgetUsdMicro })).json();

  it('creates one, and lists it with its people', async () => {
    const created = await make();
    expect(created).toMatchObject({
      name: 'Satış',
      budgetUsdMicro: 50_000_000,
      managerIds: [],
      userCount: 0,
    });
    const id = await addUser(a, 'u@a.test');
    await send('PATCH', url(a, `/${id}`), { departmentId: created.id });
    const [listed] = (await send('GET', path(a))).json().departments;
    expect(listed.userCount).toBe(1);
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'user.update' });
  });

  it('refuses a name already taken, on create and on rename', async () => {
    await make('Satış');
    const other = await make('Destek');
    const create = await send('POST', path(a), { name: 'Satış' });
    expect(create.statusCode).toBe(409);
    expect(create.json().code).toBe('department_exists');
    const rename = await send('PATCH', path(a, `/${other.id}`), { name: 'Satış' });
    expect(rename.statusCode).toBe(409);
  });

  it('lets two companies use the same name', async () => {
    await make('Satış');
    const theirs = await token('other@b.test', 'tenant-b');
    const res = await send('POST', path(b), { name: 'Satış' }, theirs);
    expect(res.statusCode).toBe(201);
  });

  it('changes the budget, and can clear it', async () => {
    const d = await make();
    const res = await send('PATCH', path(a, `/${d.id}`), { budgetUsdMicro: null });
    expect(res.json().budgetUsdMicro).toBeNull();
  });

  it.each([
    ['a negative budget', { budgetUsdMicro: -1 }],
    ['a fractional budget', { budgetUsdMicro: 1.5 }],
    ['an empty name', { name: ' ' }],
    ['nothing', {}],
  ])('refuses %s', async (_label, body) => {
    const d = await make();
    expect((await send('PATCH', path(a, `/${d.id}`), body)).statusCode).toBe(400);
  });

  it('assigns managers, and replaces them', async () => {
    const d = await make();
    const m1 = await addUser(a, 'm1@a.test', 'dept_manager');
    const m2 = await addUser(a, 'm2@a.test', 'dept_manager');
    let res = await send('PATCH', path(a, `/${d.id}`), { managerIds: [m1, m2, m1] });
    expect(res.json().managerIds.sort()).toEqual([m1, m2].sort());
    res = await send('PATCH', path(a, `/${d.id}`), { managerIds: [m2] });
    expect(res.json().managerIds).toEqual([m2]);
    res = await send('PATCH', path(a, `/${d.id}`), { managerIds: [] });
    expect(res.json().managerIds).toEqual([]);
  });

  it.each([
    ['a plain user', 'user', 'active'],
    ['a disabled manager', 'dept_manager', 'disabled'],
  ])('refuses %s as a manager', async (_label, role, status) => {
    const d = await make();
    const id = await addUser(a, 'x@a.test', role, status);
    const res = await send('PATCH', path(a, `/${d.id}`), { managerIds: [id] });
    expect(res.statusCode).toBe(400);
  });

  it("refuses another company's manager, and changes nothing", async () => {
    const d = await make();
    const mine = await addUser(a, 'm@a.test', 'dept_manager');
    await send('PATCH', path(a, `/${d.id}`), { managerIds: [mine] });
    const theirs = await addUser(b, 'm@b.test', 'dept_manager');
    const res = await send('PATCH', path(a, `/${d.id}`), { managerIds: [theirs] });
    expect(res.statusCode).toBe(400);
    const [listed] = (await send('GET', path(a))).json().departments;
    expect(listed.managerIds).toEqual([mine]);
  });

  it("answers 404 for another company's department", async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${b}, 'Theirs') returning id`;
    const id = d!['id'] as string;
    expect((await send('PATCH', path(a, `/${id}`), { name: 'Mine' })).statusCode).toBe(404);
    expect((await send('PATCH', path(b, `/${id}`), { name: 'Mine' })).statusCode).toBe(404);
    const [row] = await admin`select name from departments where id = ${id}`;
    expect(row!['name']).toBe('Theirs');
  });

  it('audits changes without names', async () => {
    const d = await make('Gizli Birim');
    await send('PATCH', path(a, `/${d.id}`), { name: 'Yeni Gizli' });
    const entries = await audit(a);
    expect(entries.map((e) => e['action'])).toEqual(['department.update', 'department.create']);
    expect(JSON.stringify(entries)).not.toContain('Gizli');
  });
});

describe('chat retention', () => {
  const path = (tenant: string) => `/api/v1/tenants/${tenant}/chat-retention`;
  const stored = async (tenant: string) => {
    const [row] = await admin`select chat_retention_months as months, policy, version
      from tenant_policies where tenant_id = ${tenant}`;
    return row;
  };

  it('is 12 months until the company says otherwise, even with no policy yet', async () => {
    await admin`delete from tenant_policies where tenant_id = ${a}`;
    await admin`delete from chat_retention_state where tenant_id = ${a}`;
    const res = await send('GET', path(a));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ months: 12, inForce: null, notice: null });
  });

  it('can be set, and is audited with both values', async () => {
    const res = await send('PUT', path(a), { months: 6 });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ months: 6, inForce: null, notice: null });
    expect((await send('GET', path(a))).json()).toMatchObject({ months: 6 });
    const [entry] = await admin`select * from audit_log
      where tenant_id = ${a} and action = 'chat_retention.update' order by ts desc limit 1`;
    expect(entry).toMatchObject({ actor_id: ownerId, target_type: 'policy' });
    expect(entry!['details']).toEqual({
      months: 6,
      previousMonths: 12,
      inForce: null,
      startsAt: null,
    });
  });

  it("creates a row the gateway and the policy page can still read, if there wasn't one", async () => {
    await admin`delete from tenant_policies where tenant_id = ${a}`;
    await send('PUT', path(a), { months: 7 });
    expect(await stored(a)).toMatchObject({ months: 7, policy: {}, version: 0 });
    const policy = await send('GET', `/api/v1/tenants/${a}/policy`);
    expect(policy.statusCode).toBe(200);
    expect(policy.json().version).toBe(0);
  });

  it("doesn't change the policy, its version, or the gateway's cache", async () => {
    const before = (await send('GET', `/api/v1/tenants/${a}/policy`)).json();
    announced.length = 0;
    await send('PUT', path(a), { months: 24 });
    const after = (await send('GET', `/api/v1/tenants/${a}/policy`)).json();
    expect(after.version).toBe(before.version);
    expect(after.policy).toEqual(before.policy);
    expect(announced).toEqual([]);
  });

  it('survives someone saving the policy', async () => {
    await send('PUT', path(a), { months: 9 });
    const current = (await send('GET', `/api/v1/tenants/${a}/policy`)).json();
    const res = await send('PUT', `/api/v1/tenants/${a}/policy`, {
      policy: current.policy,
      version: current.version,
    });
    expect(res.statusCode).toBe(200);
    expect((await send('GET', path(a))).json()).toMatchObject({ months: 9 });
  });

  it('refuses anything out of range or not a whole number of months', async () => {
    await send('PUT', path(a), { months: 12 });
    for (const months of [0, -1, 121, 1.5, '12', null]) {
      const res = await send('PUT', path(a), { months });
      expect(res.statusCode, String(months)).toBe(400);
    }
    expect((await send('PUT', path(a), {})).statusCode).toBe(400);
    expect((await send('PUT', path(a), { months: 12, never: true })).statusCode).toBe(400);
    expect((await send('GET', path(a))).json()).toMatchObject({ months: 12 });
    for (const months of [1, 120]) {
      expect((await send('PUT', path(a), { months })).statusCode).toBe(200);
    }
  });

  it("can't reach another company's", async () => {
    await admin`insert into tenant_policies (tenant_id, policy, chat_retention_months)
      values (${b}, '{}'::jsonb, 3)
      on conflict (tenant_id) do update set chat_retention_months = 3`;
    expect((await send('GET', path(b))).statusCode).toBe(404);
    expect((await send('PUT', path(b), { months: 120 })).statusCode).toBe(404);
    expect(await stored(b)).toMatchObject({ months: 3 });
  });

  it("isn't for someone who isn't an admin", async () => {
    const bearer = await token('owner@a.test', 'tenant-a', ['user']);
    expect((await send('GET', path(a), undefined, bearer)).statusCode).toBe(403);
    expect((await send('PUT', path(a), { months: 1 }, bearer)).statusCode).toBe(403);
  });

  it('a provider admin can see it, and cannot change it', async () => {
    await send('PUT', path(a), { months: 12 });
    const provider = await token('staff@katip.test', 'provider', ['provider_admin']);
    const seen = await send('GET', path(a), undefined, provider);
    expect(seen.statusCode).toBe(200);
    expect(seen.json()).toMatchObject({ months: 12 });
    const before = await admin`select count(*)::int as n from audit_log
      where tenant_id = ${a} and action = 'chat_retention.update'`;
    const res = await send('PUT', path(a), { months: 1 }, provider);
    expect(res.statusCode).toBe(403);
    expect(await stored(a)).toMatchObject({ months: 12 });
    const after = await admin`select count(*)::int as n from audit_log
      where tenant_id = ${a} and action = 'chat_retention.update'`;
    expect(after[0]!['n']).toBe(before[0]!['n']);
  });
});

describe('telling a company its chats will go', () => {
  const silent = createLogger('test', { level: 'silent' });
  const NOW = new Date('2026-11-04T10:00:00Z');
  const DAY = 86_400_000;
  let mails: Mail[] = [];
  const mailer: Mailer = async (m) => {
    mails.push(m);
  };
  const refused = () =>
    Object.assign(new Error('all recipients were rejected: x@y.test'), {
      code: 'EENVELOPE',
      responseCode: 550,
    });
  const later = () =>
    Object.assign(new Error('try later'), { code: 'EENVELOPE', responseCode: 451 });
  const path = (tenant: string) => `/api/v1/tenants/${tenant}/chat-retention`;
  let serial = 0;
  let c: string;
  let slug: string;

  const company = async () => {
    serial += 1;
    slug = `notice-${serial}`;
    c = await addTenant(slug, 10);
    return c;
  };
  /** A notice as the daily job asks for one. */
  const asked = async (tenant: string, months = 6) => {
    const id = randomUUID();
    await admin`insert into chat_retention_state (tenant_id, in_force_months, notice_id, notice_months, notice_requested_at)
      values (${tenant}, null, ${id}, ${months}, now())`;
    return id;
  };
  const state = async (tenant: string) => {
    const [row] = await admin`select * from chat_retention_state where tenant_id = ${tenant}`;
    return row!;
  };
  const notifiedAt = async (tenant: string) => {
    const value = (await state(tenant))['notified_at'] as string | null;
    return value && new Date(value);
  };
  const toldTo = () => mails.flatMap((m) => m.to).sort();

  beforeEach(async () => {
    mails = [];
    await admin`delete from chat_retention_notice_recipients`;
    await admin`delete from chat_retention_state`;
    await company();
  });

  it('tells each active person separately, once, and only in this company', async () => {
    await addUser(c, `boss-${serial}@n.test`, 'tenant_admin');
    await addUser(c, `one-${serial}@n.test`);
    await addUser(c, `off-${serial}@n.test`, 'user', 'disabled');
    const elsewhere = await addTenant(`elsewhere-${serial}`, 1);
    await addUser(elsewhere, `other-${serial}@n.test`);
    await asked(c);

    expect(await sendChatNotices(store, mailer, silent, () => NOW)).toBe(1);

    expect(toldTo()).toEqual([`boss-${serial}@n.test`, `one-${serial}@n.test`]);
    expect(mails.every((m) => m.to.length === 1)).toBe(true);
    expect(await notifiedAt(c)).toEqual(NOW);
    await sendChatNotices(store, mailer, silent, () => new Date(NOW.getTime() + DAY));
    expect(mails).toHaveLength(2);
    expect(await notifiedAt(c)).toEqual(NOW);
  });

  it('says in Turkish and English what goes, when, and who to ask, and names no chat', async () => {
    await addUser(c, `one-${serial}@n.test`);
    await asked(c, 6);
    await sendChatNotices(store, mailer, silent, () => NOW);
    const [mail] = mails;
    expect(mail!.subject).toBe(
      `${slug}: eski sohbetler 4 Aralık 2026 tarihinden itibaren silinecek`,
    );
    expect(mail!.text).toContain('6 aydan uzun süredir kullanılmayan sohbetler');
    expect(mail!.text).toContain('4 Aralık 2026');
    expect(mail!.text).toContain('yöneticisine başvurun');
    expect(mail!.text).toContain('4 December 2026');
    expect(mail!.text).toContain('6 months');
  });

  it('writes the date as it is in Turkey', () => {
    const late = new Date('2026-12-04T22:00:00Z');
    expect(chatNoticeMail('A', 1, late).subject).toContain('5 Aralık 2026');
  });

  it('audits counts, with no names or addresses', async () => {
    await addUser(c, `secret-${serial}@n.test`);
    await asked(c, 6);
    await sendChatNotices(store, mailer, silent, () => NOW);
    const [entry] = await audit(c);
    expect(entry).toMatchObject({
      action: 'chat_retention.notice_sent',
      actor_type: 'system',
      actor_id: 'console-api',
    });
    expect(entry!['details']).toEqual({
      months: 6,
      told: 1,
      refused: 0,
      startsAt: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    });
  });

  it('keeps nothing of a send that failed, and tries again', async () => {
    await addUser(c, `one-${serial}@n.test`);
    await asked(c);
    await sendChatNotices(
      store,
      async () => {
        throw new Error('smtp down');
      },
      silent,
      () => NOW,
    );
    expect(await notifiedAt(c)).toBeNull();
    expect(
      await admin`select 1 from chat_retention_notice_recipients where tenant_id = ${c}`,
    ).toHaveLength(0);
    const after = new Date(NOW.getTime() + 60_000);
    await sendChatNotices(store, mailer, silent, () => after);
    expect(mails).toHaveLength(1);
    expect(await notifiedAt(c)).toEqual(after);
  });

  it('starts the 30 days after the last send, however long the list took', async () => {
    for (const n of [1, 2, 3]) await addUser(c, `p${n}-${serial}@n.test`);
    await asked(c);
    let minutes = 0;
    const clock = () => new Date(NOW.getTime() + minutes * 60_000);
    let lastSend = NOW;
    await sendChatNotices(
      store,
      async () => {
        minutes += 10;
        lastSend = clock();
      },
      silent,
      clock,
    );
    expect(lastSend.getTime()).toBe(NOW.getTime() + 30 * 60_000);
    expect(await notifiedAt(c)).toEqual(lastSend);
  });

  it('stops trying when the server does not answer at all', async () => {
    for (const n of [1, 2, 3]) await addUser(c, `p${n}-${serial}@n.test`);
    await asked(c);
    let tries = 0;
    await sendChatNotices(
      store,
      async () => {
        tries += 1;
        throw Object.assign(new Error('refused'), { code: 'ESOCKET' });
      },
      silent,
      () => NOW,
    );
    expect(tries).toBe(1);
  });

  it('after a partial failure, tells only who is left, and counts from the last of them', async () => {
    const [p1, p2] = [`p1-${serial}@n.test`, `p2-${serial}@n.test`];
    await addUser(c, p1);
    await addUser(c, p2);
    await asked(c);
    const failing: Mailer = async (m) => {
      if (m.to[0] === p2) throw later();
      mails.push(m);
    };
    await sendChatNotices(store, failing, silent, () => NOW);
    expect(toldTo()).toEqual([p1]);
    expect(await notifiedAt(c)).toBeNull();

    const after = new Date(NOW.getTime() + 2 * DAY);
    await sendChatNotices(store, mailer, silent, () => after);
    expect(toldTo()).toEqual([p1, p2].sort());
    expect(await notifiedAt(c)).toEqual(after);
  });

  it("doesn't let an address the server refuses for good hold up everyone else", async () => {
    const [good, bad] = [`good-${serial}@n.test`, `bad-${serial}@n.test`];
    await addUser(c, good);
    await addUser(c, bad);
    await asked(c);
    await sendChatNotices(
      store,
      async (m) => {
        if (m.to[0] === bad) throw refused();
        mails.push(m);
      },
      silent,
      () => NOW,
    );
    expect(await notifiedAt(c)).toEqual(NOW);
    const [entry] = await audit(c);
    expect(entry!['details']).toMatchObject({ told: 1, refused: 1 });
  });

  it('does not count as told when every address is refused', async () => {
    await addUser(c, `one-${serial}@n.test`);
    await asked(c);
    await sendChatNotices(
      store,
      async () => {
        throw refused();
      },
      silent,
      () => NOW,
    );
    expect(await notifiedAt(c)).toBeNull();
  });

  it('keeps waiting when there is nobody to tell', async () => {
    await addUser(c, `off-${serial}@n.test`, 'user', 'disabled');
    await asked(c);
    expect(await sendChatNotices(store, mailer, silent, () => NOW)).toBe(0);
    expect(await notifiedAt(c)).toBeNull();
  });

  it('includes someone who arrives while it is still going out', async () => {
    const p1 = `p1-${serial}@n.test`;
    await addUser(c, p1);
    await asked(c);
    const p2 = `p2-${serial}@n.test`;
    await sendChatNotices(
      store,
      async () => {
        throw later();
      },
      silent,
      () => NOW,
    );
    await addUser(c, p2);
    await sendChatNotices(store, mailer, silent, () => NOW);
    expect(toldTo()).toEqual([p1, p2].sort());
  });

  it('leaves a suspended company until it is back', async () => {
    await addUser(c, `one-${serial}@n.test`);
    await asked(c);
    await admin`update tenants set status = 'suspended' where id = ${c}`;
    await sendChatNotices(store, mailer, silent, () => NOW);
    expect(mails).toEqual([]);
    await admin`update tenants set status = 'active' where id = ${c}`;
  });

  it('puts no address in its log', async () => {
    await addUser(c, `private-${serial}@n.test`);
    await asked(c);
    const lines: unknown[] = [];
    const log = { ...silent, warn: (...args: unknown[]) => lines.push(args) } as typeof silent;
    await sendChatNotices(
      store,
      async () => {
        throw later();
      },
      log,
      () => NOW,
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain('private-');
    expect(JSON.stringify(lines)).toContain(slug);
  });

  it('knows a refused address from a passing failure', () => {
    expect(addressRefused(refused())).toBe(true);
    expect(addressRefused(later())).toBe(false);
    expect(addressRefused(new Error('down'))).toBe(false);
    // A refusal of the sender, say, is the server's setup, and not about this person.
    expect(
      addressRefused(Object.assign(new Error('x'), { code: 'EMESSAGE', responseCode: 554 })),
    ).toBe(false);
  });

  describe('through the API', () => {
    const owner = () => `owner-${serial}@n.test`;
    const bearer = () => token(owner(), slug);
    const get = async () => (await send('GET', path(c), undefined, await bearer())).json();
    const put = async (months: number) =>
      (await send('PUT', path(c), { months }, await bearer())).json();
    const enforced = async (months: number) => {
      await admin`insert into tenant_policies (tenant_id, policy, version, chat_retention_months)
        values (${c}, '{}'::jsonb, 0, ${months})`;
      await admin`insert into chat_retention_state (tenant_id, in_force_months)
        values (${c}, ${months})`;
    };

    beforeEach(async () => {
      await addUser(c, owner(), 'tenant_admin');
    });

    it('asks for no email before the first run', async () => {
      expect(await put(6)).toEqual({ months: 6, inForce: null, notice: null });
      await sendChatNotices(store, mailer, silent, () => NOW);
      expect(mails).toEqual([]);
    });

    it('shortening keeps the old period, emails people, and then shows the date', async () => {
      await enforced(12);
      const saved = await put(6);
      expect(saved).toEqual({
        months: 6,
        inForce: 12,
        notice: { months: 6, notifiedAt: null, startsAt: null },
      });
      const now = new Date();
      await sendChatNotices(store, mailer, silent, () => now);
      expect(toldTo()).toEqual([owner()]);
      expect(await get()).toEqual({
        months: 6,
        inForce: 12,
        notice: {
          months: 6,
          notifiedAt: now.toISOString(),
          startsAt: new Date(now.getTime() + 30 * DAY).toISOString(),
        },
      });
    });

    it('lengthening takes effect at once, and cancels what was pending', async () => {
      await enforced(12);
      await put(6);
      expect(await put(24)).toEqual({ months: 24, inForce: 24, notice: null });
      await sendChatNotices(store, mailer, silent, () => NOW);
      expect(mails).toEqual([]);
    });

    it('a notice replaced while going out goes to everyone again, with the right text', async () => {
      await enforced(12);
      await put(6);
      await addUser(c, `late-${serial}@n.test`);
      const late = `late-${serial}@n.test`;
      await sendChatNotices(
        store,
        async (m) => {
          if (m.to[0] === late) throw later();
          mails.push(m);
        },
        silent,
        () => NOW,
      );
      expect(mails).toHaveLength(1);
      await put(3);
      mails = [];
      await sendChatNotices(store, mailer, silent, () => NOW);
      expect(toldTo()).toEqual([late, owner()].sort());
      expect(mails.every((m) => m.text.includes('3 aydan'))).toBe(true);
    });

    it('does not finish a notice replaced while it was going out', async () => {
      await enforced(12);
      await put(6);
      const pending = await store.pendingChatNotice(c);
      await put(3);
      expect(await store.finishChatNotice(c, pending!.id, NOW, { told: 1, refused: 0 })).toBe(
        false,
      );
      expect(
        await store.tellChatNotice(c, pending!.id, pending!.toTell[0]!.userId, async () => {
          throw new Error('must not be called');
        }),
      ).toBe(false);
      expect(await notifiedAt(c)).toBeNull();
    });

    it('shows what time has done, even before the daily job has noticed', async () => {
      await enforced(12);
      await put(6);
      await sendChatNotices(store, mailer, silent, () => new Date(Date.now() - 31 * DAY));
      expect(await get()).toEqual({ months: 6, inForce: 6, notice: null });
    });

    it("isn't reachable from another company", async () => {
      await enforced(12);
      await put(6);
      expect(await store.pendingChatNotice(a)).toBeNull();
      const wrong = await store.pendingChatNotice(c);
      await expect(
        store.finishChatNotice(a, wrong!.id, NOW, { told: 1, refused: 0 }),
      ).resolves.toBe(false);
      expect(await notifiedAt(c)).toBeNull();
    });
  });
});

describe('the policy', () => {
  const path = (tenant: string) => `/api/v1/tenants/${tenant}/policy`;
  const read = async () => (await send('GET', path(a))).json();
  const save = async (change: object, version?: number) => {
    const current = await read();
    return send('PUT', path(a), {
      policy: { ...current.policy, ...change },
      version: version ?? current.version,
    });
  };

  it('starts from the defaults, masking personal data', async () => {
    const body = await read();
    expect(body).toMatchObject({
      version: 0,
      kvkkAddon: false,
      policy: { atQuotaLimit: 'downgrade', residency: 'ANY_APPROVED', pii: { mode: 'mask' } },
    });
    expect(body.catalog.length).toBeGreaterThan(0);
    // The seeded embedding model is global, so a regional rule leaves uploads with no model.
    expect(body.fileSearch).toEqual({ ANY_APPROVED: true, EU_ONLY: false, TR_ONLY: false });
  });

  it('never shows prices, which are our cost', async () => {
    const text = JSON.stringify(await read());
    expect(text).not.toMatch(/price|cost/i);
    expect(text).not.toMatch(/litellm/i);
  });

  it('saves, counts the version, keeps history, audits, and tells the gateways', async () => {
    const res = await save({ atQuotaLimit: 'block', pii: { mode: 'block' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 1, policy: { atQuotaLimit: 'block' } });
    expect((await read()).policy.pii.mode).toBe('block');
    expect(announced).toEqual([`policy.changed ${a}`]);
    const [saved] =
      await admin`select version, updated_by from tenant_policies where tenant_id = ${a}`;
    expect(saved).toMatchObject({ version: 1, updated_by: ownerId });
    const history = await admin`select version from policy_history where tenant_id = ${a}`;
    expect(history).toHaveLength(1);
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'policy.update', actor_id: ownerId });
    expect(entry!['details']).toEqual({
      version: 1,
      changed: ['atQuotaLimit', 'pii'],
      piiMode: 'block',
    });
  });

  it('is what the gateway reads: the same shape in the same column', async () => {
    await save({
      allowedModels: [],
      aliases: { auto: true, fast: true, best: false, 'tr-local': false },
    });
    const [row] = await admin`select policy from tenant_policies where tenant_id = ${a}`;
    expect(row!['policy']).toMatchObject({ aliases: { best: false }, pii: { mode: 'mask' } });
  });

  it('keeps per-entity choices it does not show', async () => {
    await save({ pii: { mode: 'mask', entities: { PERSON: 'off' } } });
    const res = await save({ atQuotaLimit: 'overage' });
    expect(res.json().policy.pii.entities).toEqual({ PERSON: 'off' });
  });

  it('refuses a save over someone else’s', async () => {
    await save({ atQuotaLimit: 'block' });
    const res = await save({ atQuotaLimit: 'overage' }, 0);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('policy_changed');
    expect((await read()).policy.atQuotaLimit).toBe('block');
  });

  it('still saves if the announcement fails, as the cache expires anyway', async () => {
    failAnnounce = true;
    expect((await save({ atQuotaLimit: 'block' })).statusCode).toBe(200);
  });

  it.each([
    ['no aliases', { aliases: { auto: false, fast: false, best: false, 'tr-local': false } }],
    [
      'the Turkish model without the add-on',
      { aliases: { auto: true, fast: true, best: true, 'tr-local': true } },
    ],
    ['residency without the add-on', { residency: 'TR_ONLY' }],
    ['an unknown model', { allowedModels: ['nope'] }],
    ['an unknown behaviour', { atQuotaLimit: 'explode' }],
    ['an unknown PII mode', { pii: { mode: 'sometimes' } }],
    ['an unknown setting', { storePrompts: true }],
  ])('refuses %s, and changes nothing', async (_label, change) => {
    const res = await save(change);
    expect(res.statusCode).toBe(400);
    expect((await read()).version).toBe(0);
    expect(announced).toEqual([]);
  });

  it('lets a company with the add-on use residency and the Turkish model', async () => {
    await admin`update tenants set kvkk_addon = true where id = ${a}`;
    const res = await save({
      residency: 'TR_ONLY',
      aliases: { auto: true, fast: true, best: true, 'tr-local': true },
    });
    expect(res.statusCode).toBe(200);
  });

  it("can't reach another company's policy", async () => {
    await admin`insert into tenant_policies (tenant_id, policy) values (${b}, ${JSON.stringify({ pii: { mode: 'off' } })}::jsonb)`;
    expect((await send('GET', path(b))).statusCode).toBe(404);
    const res = await send('PUT', path(b), { policy: (await read()).policy, version: 1 });
    expect(res.statusCode).toBe(404);
    const [row] = await admin`select policy from tenant_policies where tenant_id = ${b}`;
    expect(row!['policy']).toEqual({ pii: { mode: 'off' } });
    expect(announced).toEqual([]);
  });
});

describe('access rules', () => {
  const path = (tenant: string) => `/api/v1/tenants/${tenant}/access-rules`;
  const body = {
    ipAllowlist: [] as string[],
    countries: ['TR', 'DE'],
    sessionIdleMin: 15,
    sessionMaxH: 8,
  };
  const put = async (change: object, ip = '198.51.100.7', tenant = a) =>
    api.inject({
      method: 'PUT',
      url: path(tenant),
      headers: { authorization: `Bearer ${await asOwner()}`, 'x-real-ip': ip },
      payload: { ...body, ...change },
    });

  it('starts open, with MFA required', async () => {
    const res = await send('GET', path(a));
    expect(res.json()).toMatchObject({ ipAllowlist: [], mfaRequired: true });
  });

  it('saves, sets Keycloak, and audits counts rather than addresses', async () => {
    const res = await put({ ipAllowlist: ['198.51.100.7', '203.0.113.0/24'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ipAllowlist: ['198.51.100.7/32', '203.0.113.0/24'],
      countries: ['TR', 'DE'],
      sessionIdleMin: 15,
      callerIp: '198.51.100.7',
    });
    expect(calls).toEqual(['limits tenant-a 900 28800']);
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'access_rules.update', actor_id: ownerId });
    expect(entry!['details']).toMatchObject({ ipRanges: 2, countries: 2 });
    expect(JSON.stringify(entry)).not.toContain('198.51');
  });

  it('changes nothing if Keycloak fails', async () => {
    failLimits = true;
    const res = await put({ ipAllowlist: ['198.51.100.7'] });
    expect(res.statusCode).toBe(502);
    expect((await send('GET', path(a))).json().ipAllowlist).toEqual([]);
  });

  it('refuses a list that leaves out the caller, unless forced', async () => {
    const refused = await put({ ipAllowlist: ['203.0.113.0/24'] });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe('would_lock_out');
    expect((await send('GET', path(a))).json().ipAllowlist).toEqual([]);
    const forced = await put({ ipAllowlist: ['203.0.113.0/24'], force: true });
    expect(forced.statusCode).toBe(200);
  });

  it('counts a caller inside a range, and an empty list as open', async () => {
    expect((await put({ ipAllowlist: ['198.51.100.0/24'] })).statusCode).toBe(200);
    expect((await put({ ipAllowlist: [] }, '203.0.113.9')).statusCode).toBe(200);
  });

  it('reads an IPv6 caller, and a mapped IPv4 one', async () => {
    expect((await put({ ipAllowlist: ['2001:db8::/32'] }, '2001:db8::1')).statusCode).toBe(200);
    expect((await put({ ipAllowlist: ['198.51.100.7'] }, '::ffff:198.51.100.7')).statusCode).toBe(
      200,
    );
  });

  it.each([
    ['a bad address', { ipAllowlist: ['999.1.1.1'], force: true }],
    ['a name', { ipAllowlist: ['acme.com'], force: true }],
    ['a bad prefix', { ipAllowlist: ['10.0.0.0/33'], force: true }],
    ['two slashes', { ipAllowlist: ['10.0.0.0/8/8'], force: true }],
    ['no countries', { countries: [] }],
    ['a long country', { countries: ['TUR'] }],
    ['an idle time past the realm', { sessionIdleMin: 31 }],
    ['a session past the realm', { sessionMaxH: 11 }],
    ['turning MFA off', { mfaRequired: false }],
  ])('refuses %s', async (_label, change) => {
    expect((await put(change)).statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it("can't reach another company's rules", async () => {
    expect((await send('GET', path(b))).statusCode).toBe(404);
    expect((await put({}, '198.51.100.7', b)).statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  const traefik = async () =>
    (await api.inject({ method: 'GET', url: '/internal/traefik' })).json().http;

  it("gives Traefik each company's list, open when it's empty", async () => {
    await put({ ipAllowlist: ['198.51.100.0/24'] });
    expect((await traefik()).middlewares).toEqual({
      'never-empty': { ipAllowList: { sourceRange: ['127.0.0.1/32'] } },
      'tenant-a-ipallow': { ipAllowList: { sourceRange: ['198.51.100.0/24'] } },
      'tenant-b-ipallow': { ipAllowList: { sourceRange: ['0.0.0.0/0', '::/0'] } },
    });
  });

  it.each(['suspended', 'deleted'])('gives Traefik no route to a %s company', async (status) => {
    expect(Object.keys((await traefik()).routers).sort()).toEqual(['tenant-a', 'tenant-b']);
    await admin`update tenants set status = ${status} where id = ${b}`;
    try {
      const http = await traefik();
      expect(Object.keys(http.routers)).toEqual(['tenant-a']);
      expect(Object.keys(http.services)).toEqual(['tenant-a']);
      expect(Object.keys(http.middlewares).sort()).toEqual(['never-empty', 'tenant-a-ipallow']);
      expect(JSON.stringify(http)).not.toContain('tenant-b');
    } finally {
      await admin`update tenants set status = 'active' where id = ${b}`;
    }
    expect(Object.keys((await traefik()).routers).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  it("answers Traefik with an error if a company's rules can't be read, so it keeps its last", async () => {
    const real = store.routedTenants;
    store.routedTenants = async () => {
      throw new Error('database down');
    };
    try {
      const res = await api.inject({ method: 'GET', url: '/internal/traefik' });
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain('routers');
    } finally {
      store.routedTenants = real;
    }
  });
});

describe('the Turkish model', () => {
  it('is only offered with the KVKK add-on', async () => {
    const read = async () => (await send('GET', `/api/v1/tenants/${a}/policy`)).json().catalog;
    const classes = (rows: { class: string }[]) => rows.map((m) => m.class);
    expect(classes(await read())).not.toContain('tr');
    await admin`update tenants set kvkk_addon = true where id = ${a}`;
    expect(classes(await read())).toContain('tr');
  });
});

describe('usage reports', () => {
  const day = new Date().toISOString().slice(0, 10);
  const report = (tenant: string, query: string) =>
    send('GET', `/api/v1/tenants/${tenant}/usage?${query}`);
  const model = async () =>
    (await admin`select id, display_name from model_catalog order by id limit 1`)[0]!;
  const add = async (
    tenant: string,
    user: string,
    cls: string,
    input: number,
    output: number,
    ts = 'now()',
    department: string | null = null,
  ) => {
    const m = await model();
    await admin.unsafe(
      `insert into usage_events (id, tenant_id, user_id, department_id, ts, alias, model_id, class, input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source)
       values ('${randomUUID()}', '${tenant}', '${user}', ${department ? `'${department}'` : 'null'}, ${ts}, 'fast', '${m['id']}', '${cls}', ${input}, ${output}, 7777, 7777, 'chat')`,
    );
  };

  it('matches the events, by person', async () => {
    const other = await addUser(a, 'u@a.test');
    await add(a, ownerId, 'standard', 10, 5);
    await add(a, ownerId, 'standard', 1, 1);
    await add(a, ownerId, 'premium', 100, 100);
    await add(a, other, 'tr', 4, 4);
    await add(b, otherId, 'standard', 9999, 9999);
    const res = await report(a, 'groupBy=user');
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([
      {
        key: ownerId,
        label: 'owner@a.test (owner@a.test)',
        standard: 17,
        premium: 200,
        total: 217,
      },
      { key: other, label: 'u@a.test (u@a.test)', standard: 8, premium: 0, total: 8 },
    ]);
    const [sums] =
      await admin`select sum(input_tokens + output_tokens)::int as n from usage_events where tenant_id = ${a}`;
    const total = res.json().rows.reduce((n: number, r: { total: number }) => n + r.total, 0);
    expect(total).toBe(sums!['n']);
  });

  it('stays right when asked again, and when more events arrive', async () => {
    await add(a, ownerId, 'standard', 1, 1);
    expect((await report(a, 'groupBy=day')).json().rows[0].total).toBe(2);
    expect((await report(a, 'groupBy=day')).json().rows[0].total).toBe(2);
    await add(a, ownerId, 'standard', 1, 1);
    expect((await report(a, 'groupBy=day')).json().rows[0].total).toBe(4);
  });

  it('groups by department, with those in none together', async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${a}, 'Satış') returning id`;
    await add(a, ownerId, 'standard', 10, 0, 'now()', d!['id'] as string);
    const other = await addUser(a, 'none@a.test');
    await add(a, other, 'standard', 1, 0);
    const { rows } = (await report(a, 'groupBy=dept')).json();
    expect(rows).toEqual([
      { key: d!['id'], label: 'Satış', standard: 10, premium: 0, total: 10 },
      { key: null, label: '', standard: 1, premium: 0, total: 1 },
    ]);
  });

  it('counts a day under the department someone ended it in', async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${a}, 'Satış') returning id`;
    await add(a, ownerId, 'standard', 1, 0, `now() - interval '1 minute'`);
    await add(a, ownerId, 'standard', 2, 0, 'now()', d!['id'] as string);
    const { rows } = (await report(a, 'groupBy=dept')).json();
    expect(rows).toEqual([{ key: d!['id'], label: 'Satış', standard: 3, premium: 0, total: 3 }]);
  });

  it('groups by model, under its name', async () => {
    await add(a, ownerId, 'standard', 1, 1);
    const m = await model();
    const { rows } = (await report(a, 'groupBy=model')).json();
    expect(rows[0]).toMatchObject({ key: m['id'], label: m['display_name'], total: 2 });
  });

  it('keeps to the range, by UTC day', async () => {
    await add(a, ownerId, 'standard', 1, 0, `'2026-03-10 23:59:00+00'`);
    await add(a, ownerId, 'standard', 2, 0, `'2026-03-11 00:01:00+00'`);
    await add(a, ownerId, 'standard', 4, 0, `'2026-03-12 12:00:00+00'`);
    const { rows } = (await report(a, 'groupBy=day&from=2026-03-11&to=2026-03-11')).json();
    expect(rows).toEqual([
      { key: '2026-03-11', label: '2026-03-11', standard: 2, premium: 0, total: 2 },
    ]);
    const all = (await report(a, 'groupBy=day&from=2026-03-10&to=2026-03-12')).json().rows;
    expect(all.map((r: { key: string }) => r.key)).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ]);
  });

  it('defaults to this month, and is empty when nothing happened', async () => {
    const body = (await report(a, 'groupBy=user')).json();
    expect(body.from).toBe(`${day.slice(0, 7)}-01`);
    expect(body.to).toBe(day);
    expect(body.rows).toEqual([]);
  });

  it.each([
    ['a date that does not exist', 'from=2026-02-31&to=2026-03-01'],
    ['words', 'from=yesterday'],
    ['a start after the end', 'from=2026-03-02&to=2026-03-01'],
    ['too long a range', 'from=2024-01-01&to=2026-01-01'],
    ['an unknown grouping', 'groupBy=mood'],
  ])('refuses %s', async (_label, query) => {
    expect((await report(a, query)).statusCode).toBe(400);
  });

  it('never carries cost, though the daily table holds it', async () => {
    await add(a, ownerId, 'standard', 1, 1);
    const res = await report(a, 'groupBy=model');
    expect(res.body).not.toContain('7777');
    expect(res.body).not.toMatch(/cost|price/i);
    const [row] =
      await admin`select cost_usd_micro::int as c from usage_daily where tenant_id = ${a}`;
    expect(row!['c']).toBe(7777);
  });

  it("can't reach another company's usage", async () => {
    await add(b, otherId, 'standard', 5, 5);
    expect((await report(b, 'groupBy=user')).statusCode).toBe(404);
    expect((await send('GET', `/api/v1/tenants/${b}/usage/export`)).statusCode).toBe(404);
    expect((await report(a, 'groupBy=user')).json().rows).toEqual([]);
  });

  describe('tokens with no person behind them: file search', () => {
    const NO_PERSON = '00000000-0000-0000-0000-000000000000';

    it('have a row by person, with no users row and no raw id, sorted like anyone', async () => {
      await add(a, ownerId, 'standard', 10, 0);
      await add(a, NO_PERSON, 'embedding', 500, 0);
      const res = await report(a, 'groupBy=user');
      expect(res.statusCode).toBe(200);
      const rows = res.json().rows;
      expect(rows[0]).toEqual({
        key: 'file-search',
        label: 'File search',
        standard: 500,
        premium: 0,
        total: 500,
      });
      expect(rows[1].key).toBe(ownerId);
      expect(res.body).not.toContain(NO_PERSON);
    });

    it('are the only row if nobody else has used anything', async () => {
      await add(a, NO_PERSON, 'embedding', 5, 0);
      expect(
        (await report(a, 'groupBy=user')).json().rows.map((r: { key: string }) => r.key),
      ).toEqual(['file-search']);
    });

    it('have their own row by department, apart from people in no department', async () => {
      const dept = (
        await admin`insert into departments (tenant_id, name) values (${a}, 'Muhasebe') returning id`
      )[0]!['id'] as string;
      await add(a, NO_PERSON, 'embedding', 500, 0);
      await add(a, ownerId, 'standard', 40, 0);
      await add(a, await addUser(a, 'muhasebe@a.test'), 'standard', 7, 0, 'now()', dept);
      const rows = (await report(a, 'groupBy=dept')).json().rows;
      expect(rows.map((r: { key: string | null; total: number }) => [r.key, r.total])).toEqual([
        ['file-search', 500],
        [null, 40],
        [dept, 7],
      ]);
      expect(rows[2].label).toBe('Muhasebe');
    });

    it('count in the totals by model and by day', async () => {
      await add(a, NO_PERSON, 'embedding', 500, 0);
      await add(a, ownerId, 'standard', 40, 0);
      for (const group of ['model', 'day']) {
        const rows = (await report(a, `groupBy=${group}`)).json().rows;
        expect(rows.reduce((n: number, r: { total: number }) => n + r.total, 0)).toBe(540);
        expect(JSON.stringify(rows)).not.toContain('file-search');
      }
    });

    it('stay out of a department report, and out of another company', async () => {
      const dept = (
        await admin`insert into departments (tenant_id, name) values (${a}, 'Hukuk') returning id`
      )[0]!['id'] as string;
      await add(a, NO_PERSON, 'embedding', 500, 0);
      await add(b, NO_PERSON, 'embedding', 900, 0);
      const inDept = await send(
        'GET',
        `/api/v1/tenants/${a}/departments/${dept}/usage?groupBy=user`,
      );
      expect(inDept.statusCode).toBe(200);
      expect(inDept.json().rows).toEqual([]);
      const totals = (await report(a, 'groupBy=user')).json().rows;
      expect(totals).toHaveLength(1);
      expect(totals[0].total).toBe(500);
    });

    it('are named in the CSV, in the language asked for', async () => {
      await add(a, NO_PERSON, 'embedding', 500, 0);
      const csv = (q: string) => send('GET', `/api/v1/tenants/${a}/usage/export?groupBy=user${q}`);
      expect((await csv('&lang=tr')).body).toContain('Dosya arama;500;0;500');
      expect((await csv('&lang=en')).body).toContain('File search;500;0;500');
      expect((await csv('')).body).toContain('File search;500;0;500');
      expect((await csv('')).body).not.toContain(NO_PERSON);
      const byDept = await send('GET', `/api/v1/tenants/${a}/usage/export?groupBy=dept&lang=tr`);
      expect(byDept.body).toContain('Dosya arama;500;0;500');
      expect((await csv('&lang=de')).statusCode).toBe(400);
    });
  });

  describe('as a CSV', () => {
    it('has what the report has, for Excel on a Turkish system', async () => {
      await add(a, ownerId, 'standard', 3, 4);
      const res = await send('GET', `/api/v1/tenants/${a}/usage/export?groupBy=user`);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.body.charCodeAt(0)).toBe(0xfeff);
      expect(res.body).toContain('user;standard_tokens;premium_tokens;total_tokens');
      expect(res.body).toContain('owner@a.test (owner@a.test);7;0;7');
    });

    it('stops a name running as a formula', async () => {
      const id = await addUser(a, 'evil@a.test');
      await admin`update users set name = '=HYPERLINK("http://evil.test")' where id = ${id}`;
      await add(a, id, 'standard', 1, 0);
      const res = await send('GET', `/api/v1/tenants/${a}/usage/export?groupBy=user`);
      expect(res.body).toContain(`"'=HYPERLINK(""http://evil.test"") (evil@a.test)"`);
    });
  });
});

describe('a department manager', () => {
  const asManager = () => token('m@a.test', 'tenant-a', ['dept_manager']);
  const path = (dept: string, rest = '') => `/api/v1/tenants/${a}/departments/${dept}${rest}`;
  let mine: string;
  let theirs: string;
  let managerId: string;
  let memberId: string;

  const addRequest = async (userId: string) =>
    (
      await admin`insert into requests (tenant_id, user_id, type, payload)
        values (${a}, ${userId}, 'model', ${JSON.stringify({ reason: 'Raporlar için' })}::jsonb) returning id`
    )[0]!['id'] as string;
  const addUsage = async (user: string, dept: string, tokens: number) => {
    const [m] = await admin`select id from model_catalog limit 1`;
    await admin.unsafe(
      `insert into usage_events (id, tenant_id, user_id, department_id, alias, model_id, class, input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source)
       values ('${randomUUID()}', '${a}', '${user}', '${dept}', 'fast', '${m!['id']}', 'standard', ${tokens}, 0, 1, 1, 'chat')`,
    );
  };

  beforeEach(async () => {
    const add = async (name: string) =>
      (
        await admin`insert into departments (tenant_id, name) values (${a}, ${name}) returning id`
      )[0]!['id'] as string;
    mine = await add('Satış');
    theirs = await add('Destek');
    managerId = await addUser(a, 'm@a.test', 'dept_manager');
    memberId = await addUser(a, 'member@a.test');
    await admin`insert into department_managers (tenant_id, department_id, user_id) values (${a}, ${mine}, ${managerId})`;
    await admin`update users set department_id = ${mine} where id = ${memberId}`;
  });

  it('lists only the departments they manage', async () => {
    const res = await send(
      'GET',
      `/api/v1/tenants/${a}/my-departments`,
      undefined,
      await asManager(),
    );
    expect(res.json().departments.map((d: { name: string }) => d.name)).toEqual(['Satış']);
  });

  it('a company admin sees them all', async () => {
    const res = await send('GET', `/api/v1/tenants/${a}/my-departments`);
    expect(res.json().departments).toHaveLength(2);
    expect((await send('GET', path(theirs, '/users'))).statusCode).toBe(200);
  });

  it("sees their department's people and usage, and nobody else's", async () => {
    const other = await addUser(a, 'other@a.test');
    await admin`update users set department_id = ${theirs} where id = ${other}`;
    await addUsage(memberId, mine, 5);
    await addUsage(other, theirs, 999);
    const bearer = await asManager();
    const people = await send('GET', path(mine, '/users'), undefined, bearer);
    expect(people.json().users.map((u: { email: string }) => u.email)).toEqual(['member@a.test']);
    const usage = await send('GET', path(mine, '/usage?groupBy=user'), undefined, bearer);
    expect(usage.json().rows).toHaveLength(1);
    expect(usage.json().rows[0]).toMatchObject({ key: memberId, total: 5 });
  });

  it.each([
    ['users', '/users'],
    ['usage', '/usage'],
    ['the export', '/usage/export'],
    ['requests', '/requests'],
  ])("answers 404 for another department's %s", async (_label, rest) => {
    expect((await send('GET', path(theirs, rest), undefined, await asManager())).statusCode).toBe(
      404,
    );
  });

  it('answers 404 for a department that does not exist', async () => {
    expect(
      (await send('GET', path(randomUUID(), '/users'), undefined, await asManager())).statusCode,
    ).toBe(404);
  });

  it("can't reach another company's department, even as its admin's path", async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${b}, 'Theirs') returning id`;
    expect((await send('GET', path(d!['id'] as string, '/users'))).statusCode).toBe(404);
  });

  it('a manager removed from a department loses it at once', async () => {
    const bearer = await asManager();
    expect((await send('GET', path(mine, '/users'), undefined, bearer)).statusCode).toBe(200);
    await admin`delete from department_managers where user_id = ${managerId}`;
    expect((await send('GET', path(mine, '/users'), undefined, bearer)).statusCode).toBe(404);
  });

  it('decides a request, once, and audits it without the reason', async () => {
    const id = await addRequest(memberId);
    const bearer = await asManager();
    const listed = await send('GET', path(mine, '/requests'), undefined, bearer);
    expect(listed.json().requests[0]).toMatchObject({
      id,
      type: 'model',
      reason: 'Raporlar için',
      status: 'pending',
      userEmail: 'member@a.test',
    });
    const res = await send('PATCH', path(mine, `/requests/${id}`), { status: 'approved' }, bearer);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('approved');
    const [row] = await admin`select status, decided_by from requests where id = ${id}`;
    expect(row).toMatchObject({ status: 'approved', decided_by: managerId });
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'request.decide', actor_id: managerId });
    expect(JSON.stringify(entry)).not.toContain('Raporlar');
    const again = await send(
      'PATCH',
      path(mine, `/requests/${id}`),
      { status: 'rejected' },
      bearer,
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('already_decided');
  });

  it('cannot decide their own request', async () => {
    await admin`update users set department_id = ${mine} where id = ${managerId}`;
    const id = await addRequest(managerId);
    const res = await send(
      'PATCH',
      path(mine, `/requests/${id}`),
      { status: 'approved' },
      await asManager(),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('own_request');
  });

  it("can't decide a request from another department, through their own path", async () => {
    const other = await addUser(a, 'other@a.test');
    await admin`update users set department_id = ${theirs} where id = ${other}`;
    const id = await addRequest(other);
    const res = await send(
      'PATCH',
      path(mine, `/requests/${id}`),
      { status: 'approved' },
      await asManager(),
    );
    expect(res.statusCode).toBe(404);
    const [row] = await admin`select status from requests where id = ${id}`;
    expect(row!['status']).toBe('pending');
  });

  it.each([{ status: 'pending' }, { status: 'approved', decided_by: 'x' }, {}])(
    'refuses the body %j',
    async (body) => {
      const id = await addRequest(memberId);
      const res = await send('PATCH', path(mine, `/requests/${id}`), body, await asManager());
      expect(res.statusCode).toBe(400);
    },
  );

  it('still cannot use company screens', async () => {
    const bearer = await asManager();
    for (const route of ['users', 'overview', 'policy', 'access-rules', 'usage', 'departments']) {
      const res = await send('GET', `/api/v1/tenants/${a}/${route}`, undefined, bearer);
      expect(res.statusCode, route).toBe(403);
    }
  });
});

describe('my account', () => {
  const asUser = () => token('u@a.test', 'tenant-a', ['user']);
  let userId: string;
  let otherUser: string;
  beforeEach(async () => {
    userId = await addUser(a, 'u@a.test');
    otherUser = await addUser(a, 'other@a.test');
  });
  const addUsage = async (user: string, tokens: number) => {
    const [m] = await admin`select id from model_catalog limit 1`;
    await admin.unsafe(
      `insert into usage_events (id, tenant_id, user_id, alias, model_id, class, input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source)
       values ('${randomUUID()}', '${a}', '${user}', 'fast', '${m!['id']}', 'standard', ${tokens}, 0, 5555, 5555, 'chat')`,
    );
  };

  it('shows only their own usage, at once, and no cost', async () => {
    await addUsage(userId, 7);
    await addUsage(otherUser, 999);
    const res = await send('GET', '/api/v1/me/usage?groupBy=day', undefined, await asUser());
    expect(res.json().rows.map((r: { total: number }) => r.total)).toEqual([7]);
    expect(res.body).not.toContain('5555');
  });

  it('raises a request, sees it, and it reaches the admin', async () => {
    const bearer = await asUser();
    const made = await send(
      'POST',
      '/api/v1/me/requests',
      { type: 'budget', reason: 'Daha fazla' },
      bearer,
    );
    expect(made.statusCode).toBe(201);
    const mine = await send('GET', '/api/v1/me/requests', undefined, bearer);
    expect(mine.json().requests[0]).toMatchObject({
      type: 'budget',
      reason: 'Daha fazla',
      status: 'pending',
    });
    const all = await send('GET', `/api/v1/tenants/${a}/requests`);
    expect(all.json().requests[0]).toMatchObject({ userEmail: 'u@a.test', reason: 'Daha fazla' });
    const decided = await send('PATCH', `/api/v1/tenants/${a}/requests/${made.json().id}`, {
      status: 'rejected',
    });
    expect(decided.json().status).toBe('rejected');
    expect(
      (await send('GET', '/api/v1/me/requests', undefined, bearer)).json().requests[0].status,
    ).toBe('rejected');
  });

  it('does not see anyone else’s requests', async () => {
    await admin`insert into requests (tenant_id, user_id, type, payload) values (${a}, ${otherUser}, 'model', '{"reason":"gizli"}'::jsonb)`;
    const res = await send('GET', '/api/v1/me/requests', undefined, await asUser());
    expect(res.json().requests).toEqual([]);
  });

  it('cannot flood the company with requests', async () => {
    const bearer = await asUser();
    for (let i = 0; i < 10; i += 1) {
      await send('POST', '/api/v1/me/requests', { type: 'model', reason: `r${i}` }, bearer);
    }
    const res = await send('POST', '/api/v1/me/requests', { type: 'model', reason: 'r' }, bearer);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('too_many_requests');
  });

  it.each([
    ['an unknown type', { type: 'world', reason: 'r' }],
    ['no reason', { type: 'model', reason: ' ' }],
    ['someone else as the requester', { type: 'model', reason: 'r', userId: randomUUID() }],
  ])('refuses %s', async (_label, body) => {
    expect((await send('POST', '/api/v1/me/requests', body, await asUser())).statusCode).toBe(400);
  });

  it('exports what is held about them, and nobody else, and says where chats are', async () => {
    await addUsage(userId, 7);
    await addUsage(otherUser, 999);
    await admin`insert into requests (tenant_id, user_id, type, payload) values (${a}, ${userId}, 'model', '{"reason":"benim"}'::jsonb)`;
    await admin`insert into requests (tenant_id, user_id, type, payload) values (${a}, ${otherUser}, 'model', '{"reason":"gizli"}'::jsonb)`;
    const res = await send('POST', '/api/v1/me/privacy/export', undefined, await asUser());
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    const data = res.json();
    expect(data.account).toMatchObject({ email: 'u@a.test', role: 'user' });
    expect(data.usageByDay.map((u: { total: number }) => u.total)).toEqual([7]);
    expect(data.requests.map((r: { reason: string }) => r.reason)).toEqual(['benim']);
    expect(data.chats).toContain('LibreChat');
    expect(res.body).not.toContain('other@a.test');
    expect(res.body).not.toContain('gizli');
    expect(res.body).not.toContain('5555');
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'privacy.export', actor_id: userId });
  });

  it('asks for deletion once, deletes nothing itself, and the admin sees it', async () => {
    const bearer = await asUser();
    const first = await send('POST', '/api/v1/me/privacy/delete', undefined, bearer);
    const second = await send('POST', '/api/v1/me/privacy/delete', undefined, bearer);
    expect(first.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
    const [row] = await admin`select status from users where id = ${userId}`;
    expect(row!['status']).toBe('active');
    const all = await send('GET', `/api/v1/tenants/${a}/requests`);
    expect(all.json().privacy[0]).toMatchObject({
      type: 'delete',
      status: 'pending',
      userEmail: 'u@a.test',
    });
    const url = `/api/v1/tenants/${a}/privacy-requests/${first.json().id}`;

    // Only the deletion job can say a deletion is done.
    const notDone = await send('PATCH', url, { status: 'completed' });
    expect(notDone.statusCode).toBe(409);
    expect(notDone.json().code).toBe('deletion_needs_approval');

    const approved = await send('PATCH', url, { status: 'approved' });
    expect(approved.json().status).toBe('approved');
    const [off] = await admin`select status from users where id = ${userId}`;
    expect(off!['status']).toBe('disabled');
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'privacy.delete_approve', actor_id: ownerId });

    const twice = await send('PATCH', url, { status: 'approved' });
    expect(twice.statusCode).toBe(409);
    const back = await send('PATCH', `/api/v1/tenants/${a}/users/${userId}`, { status: 'active' });
    expect(back.statusCode).toBe(409);
    expect(back.json().code).toBe('deletion_approved');
  });

  it('marks an export request as handled, which is not a deletion', async () => {
    const [row] = await admin`insert into privacy_requests (tenant_id, user_id, type)
      values (${a}, ${userId}, 'export') returning id`;
    const done = await send('PATCH', `/api/v1/tenants/${a}/privacy-requests/${row!['id']}`, {
      status: 'completed',
    });
    expect(done.json().status).toBe('completed');
    const approved = await send('PATCH', `/api/v1/tenants/${a}/privacy-requests/${row!['id']}`, {
      status: 'approved',
    });
    expect(approved.statusCode).toBe(404);
  });

  it("won't delete a company's last admin, and hides someone once they're deleted", async () => {
    const [own] = await admin`insert into privacy_requests (tenant_id, user_id, type)
      values (${a}, ${ownerId}, 'delete') returning id`;
    const last = await send('PATCH', `/api/v1/tenants/${a}/privacy-requests/${own!['id']}`, {
      status: 'approved',
    });
    expect(last.statusCode).toBe(409);
    expect(last.json().code).toBe('last_admin');
    const [still] = await admin`select status from users where id = ${ownerId}`;
    expect(still!['status']).toBe('active');
    await admin`update users set status = 'deleted' where id = ${userId}`;
    const list = await send('GET', `/api/v1/tenants/${a}/users`);
    expect(JSON.stringify(list.json())).not.toContain(userId);
    const edit = await send('PATCH', `/api/v1/tenants/${a}/users/${userId}`, { name: 'Geri' });
    expect(edit.statusCode).toBe(404);
  });

  it("can't reach another company's requests or mark them handled", async () => {
    const other = await addUser(b, 'x@b.test');
    const [r] =
      await admin`insert into privacy_requests (tenant_id, user_id, type) values (${b}, ${other}, 'delete') returning id`;
    const [q] =
      await admin`insert into requests (tenant_id, user_id, type, payload) values (${b}, ${other}, 'model', '{}'::jsonb) returning id`;
    expect((await send('GET', `/api/v1/tenants/${b}/requests`)).statusCode).toBe(404);
    expect(
      (
        await send('PATCH', `/api/v1/tenants/${a}/privacy-requests/${r!['id']}`, {
          status: 'completed',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await send('PATCH', `/api/v1/tenants/${a}/requests/${q!['id']}`, { status: 'approved' }))
        .statusCode,
    ).toBe(404);
    const [row] = await admin`select status from privacy_requests where id = ${r!['id'] as string}`;
    expect(row!['status']).toBe('pending');
  });

  it('a plain user cannot use the admin side', async () => {
    const res = await send('GET', `/api/v1/tenants/${a}/requests`, undefined, await asUser());
    expect(res.statusCode).toBe(403);
  });
});

describe('the audit log', () => {
  const log = (tenant: string, query = '') =>
    send('GET', `/api/v1/tenants/${tenant}/audit${query}`);
  const add = async (tenant: string, action: string, actor: string, ts: string) =>
    admin.unsafe(
      `insert into audit_log (id, tenant_id, actor_type, actor_id, action, target_type, ts, details)
       values ('${randomUUID()}', '${tenant}', 'user', '${actor}', '${action}', 'user', '${ts}', '{"n":1}')`,
    );

  it('shows what happened, who did it, newest first', async () => {
    await send('POST', url(a), { email: 'n@a.test', name: 'N' });
    await send('POST', `/api/v1/tenants/${a}/departments`, { name: 'Satış' });
    const { entries } = (await log(a)).json();
    expect(entries.map((e: { action: string }) => e.action)).toEqual([
      'department.create',
      'user.invite',
    ]);
    expect(entries[1]).toMatchObject({
      actorType: 'user',
      actor: 'owner@a.test (owner@a.test)',
      targetType: 'user',
    });
  });

  it('pages through, without repeating or missing anyone', async () => {
    for (let i = 0; i < 5; i += 1) {
      await add(a, 'user.update', ownerId, `2026-03-0${i + 1}T00:00:00Z`);
    }
    const first = (await log(a, '?limit=2')).json();
    expect(first.entries).toHaveLength(2);
    const second = (await log(a, `?limit=2&before=${encodeURIComponent(first.next)}`)).json();
    const third = (await log(a, `?limit=2&before=${encodeURIComponent(second.next)}`)).json();
    expect(third.next).toBeNull();
    const days = [...first.entries, ...second.entries, ...third.entries].map((e) =>
      e.ts.slice(0, 10),
    );
    expect(days).toEqual(['2026-03-05', '2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01']);
  });

  it('filters by action', async () => {
    await add(a, 'user.update', ownerId, '2026-03-01T00:00:00Z');
    await add(a, 'policy.update', ownerId, '2026-03-02T00:00:00Z');
    const { entries } = (await log(a, '?action=policy.update')).json();
    expect(entries.map((e: { action: string }) => e.action)).toEqual(['policy.update']);
  });

  it.each(['?limit=0', '?limit=201', '?before=yesterday', "?action=x'%20or%201=1"])(
    'refuses %s',
    async (query) => {
      expect((await log(a, query)).statusCode).toBe(400);
    },
  );

  it("never shows another company's entries, or names their people", async () => {
    await add(b, 'user.update', otherId, '2026-03-01T00:00:00Z');
    await add(a, 'user.update', otherId, '2026-03-02T00:00:00Z');
    expect((await log(b)).statusCode).toBe(404);
    const { entries } = (await log(a)).json();
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBeNull();
  });

  it('holds no names or addresses in what it records', async () => {
    await send('POST', url(a), { email: 'ayse.gizli@a.test', name: 'Ayşe Gizli' });
    const rows =
      await admin`select actor_id, target_id, details from audit_log where tenant_id = ${a}`;
    expect(JSON.stringify(rows)).not.toMatch(/gizli/i);
  });

  it('records every kind of change', async () => {
    const id = await addUser(a, 'u@a.test');
    const bearer = await token('u@a.test', 'tenant-a', ['user']);
    const made = await send(
      'POST',
      '/api/v1/me/requests',
      { type: 'model', reason: 'gizli sebep' },
      bearer,
    );
    await send('POST', '/api/v1/me/privacy/delete', undefined, bearer);
    await send('POST', '/api/v1/me/privacy/export', undefined, bearer);
    await send('PATCH', `/api/v1/tenants/${a}/requests/${made.json().id}`, { status: 'approved' });
    await send('PATCH', url(a, `/${id}`), { name: 'Yeni' });
    const policy = (await send('GET', `/api/v1/tenants/${a}/policy`)).json();
    await send('PUT', `/api/v1/tenants/${a}/policy`, {
      policy: policy.policy,
      version: policy.version,
    });
    const created = await send('POST', `/api/v1/tenants/${a}/departments`, { name: 'S' });
    await send('PATCH', `/api/v1/tenants/${a}/departments/${created.json().id}`, { name: 'T' });
    await api.inject({
      method: 'PUT',
      url: `/api/v1/tenants/${a}/access-rules`,
      headers: { authorization: `Bearer ${await asOwner()}` },
      payload: { ipAllowlist: [], countries: ['TR'], sessionIdleMin: 30, sessionMaxH: 10 },
    });
    await send('POST', url(a), { email: 'n@a.test', name: 'N' });
    const rows = await admin`select distinct action from audit_log where tenant_id = ${a}`;
    expect(rows.map((r) => r['action']).sort()).toEqual([
      'access_rules.update',
      'department.create',
      'department.update',
      'policy.update',
      'privacy.delete_request',
      'privacy.export',
      'request.create',
      'request.decide',
      'user.invite',
      'user.update',
    ]);
    const all = await admin`select details from audit_log where tenant_id = ${a}`;
    expect(JSON.stringify(all)).not.toContain('gizli sebep');
  });

  describe('for a provider admin', () => {
    const provider = () => token('staff@katip.test', 'provider', ['provider_admin']);
    it('shows every company, newest first, and can narrow to one', async () => {
      await add(a, 'user.update', ownerId, '2026-03-01T00:00:00Z');
      await add(b, 'policy.update', otherId, '2026-03-02T00:00:00Z');
      const bearer = await provider();
      const all = (await send('GET', '/api/v1/admin/audit', undefined, bearer)).json();
      expect(all.entries.map((e: { tenantSlug: string }) => e.tenantSlug)).toEqual([
        'tenant-b',
        'tenant-a',
      ]);
      const one = (await send('GET', `/api/v1/admin/audit?tenant=${a}`, undefined, bearer)).json();
      expect(one.entries.map((e: { tenantSlug: string }) => e.tenantSlug)).toEqual(['tenant-a']);
    });
  });
});

describe('usage alerts', () => {
  const month = new Date().toISOString().slice(0, 7).replace('-', '');
  const silent = createLogger('test', { level: 'silent' });
  const mails: Mail[] = [];
  const mailer: Mailer = async (m) => {
    mails.push(m);
  };
  const setLimit = (tenant: string, standard: number, premium = 1000) =>
    admin`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
      values (${tenant}, ${month}, ${standard}, ${premium}, 10)
      on conflict (tenant_id, month) do update set std_tokens = excluded.std_tokens`;
  const use = async (tenant: string, tokens: number, cls = 'standard') =>
    admin.unsafe(
      `insert into usage_events (id, tenant_id, user_id, alias, model_id, class, input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source)
       values ('${randomUUID()}', '${tenant}', '${randomUUID()}', 'fast', 'm', '${cls}', ${tokens}, 0, 1, 1, 'chat')`,
    );
  beforeEach(() => {
    mails.length = 0;
  });

  it('stays quiet under 50%', async () => {
    await setLimit(a, 100);
    await use(a, 49);
    await checkAlerts(store, mailer, silent);
    expect(mails).toEqual([]);
  });

  it('tells the admins once at each threshold', async () => {
    await setLimit(a, 100);
    await use(a, 50);
    await checkAlerts(store, mailer, silent);
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toEqual(['owner@a.test']);
    expect(mails[0]!.subject).toContain('%50');
    await use(a, 30);
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(2);
    expect(mails[1]!.subject).toContain('%80');
    await use(a, 20);
    await checkAlerts(store, mailer, silent);
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(3);
    expect(mails[2]!.subject).toContain('doldu');
  });

  it('jumping past several sends one email, for the highest', async () => {
    await setLimit(a, 100);
    await use(a, 95);
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('%80');
  });

  it('retries next time if the email fails', async () => {
    await setLimit(a, 100);
    await use(a, 50);
    await checkAlerts(
      store,
      async () => {
        throw new Error('smtp down');
      },
      silent,
    );
    expect(await admin`select 1 from budget_alerts where tenant_id = ${a}`).toHaveLength(0);
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(1);
  });

  it('counts each kind of token apart, and only this month', async () => {
    await setLimit(a, 100, 100);
    await use(a, 60, 'premium');
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain('premium');
    await checkAlerts(store, mailer, silent, new Date('2020-01-15T00:00:00Z'));
    expect(mails).toHaveLength(1);
  });

  it('tells only that company, and only its active admins', async () => {
    await addUser(a, 'second@a.test', 'tenant_admin');
    await addUser(a, 'off@a.test', 'tenant_admin', 'disabled');
    await addUser(a, 'plain@a.test');
    await setLimit(a, 100);
    await setLimit(b, 100);
    await use(a, 60);
    await checkAlerts(store, mailer, silent);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to.sort()).toEqual(['owner@a.test', 'second@a.test']);
  });

  it('skips a suspended company', async () => {
    await admin`update tenants set status = 'suspended' where id = ${a}`;
    await setLimit(a, 100);
    await use(a, 60);
    await checkAlerts(store, mailer, silent);
    expect(mails).toEqual([]);
  });

  it('shows on the overview, and holds no usage detail in the email', async () => {
    await setLimit(a, 100);
    await use(a, 85);
    await checkAlerts(store, mailer, silent);
    const res = await send('GET', `/api/v1/tenants/${a}/overview`);
    expect(res.json().alerts).toEqual([{ class: 'standard', threshold: 80 }]);
    expect(mails[0]!.text).not.toMatch(/\b85\b/);
  });
});

describe("a department's stricter rules", () => {
  const path = (dept: string, tenant = a) => `/api/v1/tenants/${tenant}/departments/${dept}/policy`;
  let dept: string;
  const setCompany = async (change: object) => {
    const current = (await send('GET', `/api/v1/tenants/${a}/policy`)).json();
    return send('PUT', `/api/v1/tenants/${a}/policy`, {
      policy: { ...current.policy, ...change },
      version: current.version,
    });
  };
  beforeEach(async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${a}, 'Satış') returning id`;
    dept = d!['id'] as string;
  });

  it('saves what is stricter, audits it, and tells the gateways', async () => {
    announced.length = 0;
    const res = await send('PUT', path(dept), {
      aliases: { best: false },
      atQuotaLimit: 'block',
      pii: { mode: 'block' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().override).toMatchObject({ atQuotaLimit: 'block', pii: { mode: 'block' } });
    const [row] = await admin`select policy_override from departments where id = ${dept}`;
    expect(row!['policy_override']).toMatchObject({ aliases: { best: false } });
    expect(announced).toEqual([`policy.changed ${a}`]);
    const [entry] = await audit(a);
    expect(entry).toMatchObject({ action: 'department.policy', target_id: dept });
  });

  it('can clear them', async () => {
    await send('PUT', path(dept), { atQuotaLimit: 'block' });
    expect((await send('PUT', path(dept), {})).json().override).toEqual({});
  });

  it.each([
    ['less personal data protection', { pii: { mode: 'off' } }],
    ['less strictness at the limit', { atQuotaLimit: 'overage' }],
    ['a setting it has no say in', { residency: 'EU_ONLY' }],
  ])('refuses %s, and changes nothing', async (_label, body) => {
    expect((await send('PUT', path(dept), body)).statusCode).toBe(400);
    const [row] = await admin`select policy_override from departments where id = ${dept}`;
    expect(row!['policy_override']).toBeNull();
  });

  it('refuses what the company has off, or does not allow', async () => {
    const catalog = (await send('GET', `/api/v1/tenants/${a}/policy`)).json().catalog;
    const [one, two] = catalog.map((m: { id: string }) => m.id);
    await setCompany({
      aliases: { auto: true, fast: true, best: false, 'tr-local': false },
      allowedModels: [one],
    });
    expect((await send('PUT', path(dept), { aliases: { best: true } })).statusCode).toBe(400);
    expect((await send('PUT', path(dept), { allowedModels: [two] })).statusCode).toBe(400);
    expect((await send('PUT', path(dept), { allowedModels: [one] })).statusCode).toBe(200);
  });

  it("can't reach another company's department", async () => {
    const [d] =
      await admin`insert into departments (tenant_id, name) values (${b}, 'Theirs') returning id`;
    const id = d!['id'] as string;
    expect((await send('GET', path(id))).statusCode).toBe(404);
    expect((await send('PUT', path(id), { atQuotaLimit: 'block' })).statusCode).toBe(404);
    expect((await send('GET', path(id, b))).statusCode).toBe(404);
  });

  it('keeps per-entity choices on the company policy, and refuses unknown modes', async () => {
    const saved = await setCompany({
      pii: { mode: 'mask', entities: { PERSON: 'off', TR_TCKN: 'block' } },
    });
    expect(saved.json().policy.pii.entities).toEqual({ PERSON: 'off', TR_TCKN: 'block' });
    const bad = await setCompany({ pii: { mode: 'mask', entities: { PERSON: 'sometimes' } } });
    expect(bad.statusCode).toBe(400);
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
