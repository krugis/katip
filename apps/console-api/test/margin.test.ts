// SPDX-License-Identifier: AGPL-3.0-only
// The provider's margin (tracker P1-47) on real Postgres as katip_console: known numbers to the
// micro-USD, and that a company still can't see cost or margin anywhere.
import { randomUUID } from 'node:crypto';
import { migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { createLogger } from '@katip/shared';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { FastifyInstance } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApi } from '../src/app.js';
import { createVerifier } from '../src/auth.js';
import type { IdentityClient } from '../src/identity.js';
import { marginCsv, marginPct, marginReport } from '../src/margin.js';
import { DbConsoleStore } from '../src/stores.js';

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
const ISSUER = 'https://auth.test/realms/katip';
const NO_PERSON = '00000000-0000-0000-0000-000000000000';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let store: DbConsoleStore;
let api: FastifyInstance;
let key: SigningKey;
let alfa: string;
let beta: string;
let gone: string;
let ownerId: string;
let deptId: string;

const identity: IdentityClient = {
  invite: async () => ({ keycloakId: 'kc' }),
  sendInvite: async () => undefined,
  setRole: async () => undefined,
  setEnabled: async () => undefined,
  setSessionLimits: async () => undefined,
};

const token = (email: string, organization: string, roles: string[]) =>
  new SignJWT({ realm_access: { roles }, organization: [organization], email })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('kc-user')
    .setIssuer(ISSUER)
    .setAudience('console-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key);
const provider = () => token('staff@katip.test', 'provider', ['provider_admin']);
const owner = () => token('owner@alfa.test', 'alfa', ['tenant_admin']);

const get = async (path: string, bearer?: string) =>
  api.inject({
    method: 'GET',
    url: path,
    headers: { authorization: `Bearer ${bearer ?? (await provider())}` },
  });

const consoleUrl = (role = 'katip_console', password = 'console-test-password') => {
  const url = new URL(container.getConnectionUri());
  url.username = role;
  url.password = password;
  return url.toString();
};

const addTenant = async (
  slug: string,
  seats: Record<string, number>,
  opts: { kvkk?: boolean; status?: string; cycle?: string } = {},
) => {
  const [t] = await admin`insert into tenants (slug, name, status, kvkk_addon, created_at)
    values (${slug}, ${`${slug} A.Ş.`}, ${opts.status ?? 'active'}, ${opts.kvkk ?? false},
      '2026-01-01T00:00:00Z') returning id`;
  const id = t!['id'] as string;
  for (const [plan, quantity] of Object.entries(seats)) {
    await admin`insert into seats (tenant_id, plan_code, quantity) values (${id}, ${plan}, ${quantity})`;
  }
  if (opts.cycle) {
    await admin`insert into subscriptions (tenant_id, billing_cycle, status, period_start, period_end)
      values (${id}, ${opts.cycle}, 'active', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`;
  }
  return id;
};

interface Event {
  tenant: string;
  user?: string;
  department?: string | null;
  ts: string;
  alias?: string;
  model: string;
  cls: string;
  cost: number;
  price: number;
  overage?: boolean;
  fallback?: boolean;
  source?: string;
  input?: number;
  output?: number;
}
const addEvent = (e: Event) =>
  admin`insert into usage_events (id, tenant_id, user_id, department_id, ts, alias, model_id,
      class, input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source, overage, fallback)
    values (${randomUUID()}, ${e.tenant}, ${e.user ?? ownerId}, ${e.department ?? null}, ${e.ts},
      ${e.alias ?? 'fast'}, ${e.model}, ${e.cls}, ${e.input ?? 10}, ${e.output ?? 5}, ${e.cost},
      ${e.price}, ${e.source ?? 'chat'}, ${e.overage ?? false}, ${e.fallback ?? false})`;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await seed(drizzle(admin, { schema }), { tenant: null });
  await admin.unsafe(`ALTER ROLE katip_console PASSWORD 'console-test-password'`);
  await admin.unsafe(`ALTER ROLE katip_gateway PASSWORD 'gateway-test-password'`);
  store = new DbConsoleStore(consoleUrl());

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
    baseDomain: 'katip.test',
  });
}, 240_000);

afterAll(async () => {
  await api?.close();
  await store?.close();
  await admin?.end();
  await container?.stop();
});

/**
 * March 2026, in micro-USD. Seed prices: business 9.60/month billed monthly, starter 6.00 and
 * studio 14.00 billed annually, the KVKK add-on 8.40 billed monthly.
 *
 * alfa: 3 business seats, monthly, KVKK add-on. Seats 3 × 9_600_000 = 28_800_000; add-on
 *   3 × 8_400_000 = 25_200_000; overage 600_000. Cost 1_234 + 500_000 + 10 = 501_244.
 * beta: 2 starter seats, annual by default, no usage. Seats 2 × 6_000_000 = 12_000_000.
 * gone: 1 studio seat, deleted on 15 March and purged: 14_000_000; cost 12_000_000.
 */
beforeEach(async () => {
  await admin`truncate audit_log, usage_events, usage_daily`;
  await admin`truncate tenants cascade`;
  await admin`delete from plans where version > 1`;
  alfa = await addTenant('alfa', { business: 3 }, { kvkk: true, cycle: 'monthly' });
  beta = await addTenant('beta', { starter: 2 });
  gone = await addTenant('gone', { studio: 1 }, { status: 'deleted' });
  await admin`insert into audit_log (id, tenant_id, actor_type, actor_id, action, target_type, target_id, ts)
    values (${randomUUID()}, ${gone}, 'system', 'provisioner', 'tenant.delete', 'tenant', 'gone',
      '2026-03-15T10:00:00Z')`;
  const [u] =
    await admin`insert into users (tenant_id, keycloak_id, email, name, role, seat_plan_code, status)
    values (${alfa}, 'kc-owner', 'owner@alfa.test', 'Owner', 'tenant_admin', 'business', 'active')
    returning id`;
  ownerId = u!['id'] as string;
  const [d] =
    await admin`insert into departments (tenant_id, name) values (${alfa}, 'Satış') returning id`;
  deptId = d!['id'] as string;

  // In: the first and the last instant of March, in UTC.
  await addEvent({
    tenant: alfa,
    department: deptId,
    ts: '2026-03-01T00:00:00Z',
    model: 'std-deepseek-v4-flash',
    cls: 'standard',
    cost: 1_234,
    price: 1_234,
  });
  // Asked for "best", answered by the fallback: counted under the model that answered.
  await addEvent({
    tenant: alfa,
    department: deptId,
    ts: '2026-03-31T23:59:59.999Z',
    alias: 'best',
    model: 'prem-gemini-4-argon',
    cls: 'premium',
    cost: 500_000,
    price: 600_000,
    overage: true,
    fallback: true,
  });
  // File search: nobody behind it, still the company's.
  await addEvent({
    tenant: alfa,
    user: NO_PERSON,
    ts: '2026-03-10T12:00:00Z',
    model: 'emb-bge-m3',
    cls: 'embedding',
    source: 'embedding',
    cost: 10,
    price: 10,
  });
  // Out: February in UTC, though it is already 1 March in Istanbul; and April.
  await addEvent({
    tenant: alfa,
    ts: '2026-03-01T02:00:00+03:00',
    model: 'std-deepseek-v4-flash',
    cls: 'standard',
    cost: 99_000_000,
    price: 99_000_000,
    overage: true,
  });
  await addEvent({
    tenant: alfa,
    ts: '2026-04-01T00:00:00Z',
    model: 'std-deepseek-v4-flash',
    cls: 'standard',
    cost: 88_000_000,
    price: 88_000_000,
  });
  await addEvent({
    tenant: gone,
    user: randomUUID(),
    ts: '2026-03-05T09:00:00Z',
    model: 'std-glm-5.3-flash',
    cls: 'standard',
    cost: 12_000_000,
    price: 0,
  });
});

describe('the margin per company and month', () => {
  it('adds up each company to the micro-USD', async () => {
    const res = await get('/api/v1/admin/margin?month=2026-03');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.month).toBe('2026-03');
    expect(body.basis).toBe('list_price');
    expect(body.tenants.map((t: { slug: string }) => t.slug)).toEqual(['alfa', 'beta', 'gone']);
    expect(body.tenants[0]).toEqual({
      tenantId: alfa,
      slug: 'alfa',
      name: 'alfa A.Ş.',
      status: 'active',
      billingCycle: 'monthly',
      seats: 3,
      requests: 3,
      revenue: { seats: 28_800_000, addons: 25_200_000, overage: 600_000, total: 54_600_000 },
      cost: 501_244,
      margin: 54_098_756,
      marginPct: 99.1,
      belowTarget: false,
    });
  });

  it('shows a company with seats and no usage, by its seat revenue', async () => {
    const body = (await get('/api/v1/admin/margin?month=2026-03')).json();
    expect(body.tenants[1]).toMatchObject({
      slug: 'beta',
      billingCycle: null,
      seats: 2,
      requests: 0,
      revenue: { seats: 12_000_000, addons: 0, overage: 0, total: 12_000_000 },
      cost: 0,
      margin: 12_000_000,
      marginPct: 100,
    });
  });

  it('keeps a deleted and purged company in its history, by its slug', async () => {
    // A purge keeps the tenant row, so its slug can't be reused, and its usage (LLD-10 §8).
    const body = (await get('/api/v1/admin/margin?month=2026-03')).json();
    expect(body.tenants[2]).toMatchObject({
      slug: 'gone',
      status: 'deleted',
      revenue: { seats: 14_000_000, total: 14_000_000 },
      cost: 12_000_000,
      margin: 2_000_000,
      marginPct: 14.3,
      belowTarget: true,
    });
    // Deleted in March, so no seats after it.
    const may = (await get('/api/v1/admin/margin?month=2026-05')).json();
    expect(may.tenants.map((t: { slug: string }) => t.slug)).toEqual(['alfa', 'beta']);
  });

  it('gives the platform total', async () => {
    const { total } = (await get('/api/v1/admin/margin?month=2026-03')).json();
    expect(total).toEqual({
      seats: 6,
      requests: 4,
      revenue: { seats: 54_800_000, addons: 25_200_000, overage: 600_000, total: 80_600_000 },
      cost: 12_501_244,
      margin: 68_098_756,
      marginPct: 84.5,
    });
  });

  it("gives the month's cost by the model that answered, most expensive first", async () => {
    const { models } = (await get('/api/v1/admin/margin?month=2026-03')).json();
    expect(models.map((m: { modelId: string; cost: number }) => [m.modelId, m.cost])).toEqual([
      ['std-glm-5.3-flash', 12_000_000],
      ['prem-gemini-4-argon', 500_000],
      ['std-deepseek-v4-flash', 1_234],
      ['emb-bge-m3', 10],
    ]);
    expect(models[1]).toMatchObject({ label: 'Gemini 4 Argon', class: 'premium', requests: 1 });
    expect(models[0].sharePct).toBe(96);
    expect(JSON.stringify(models)).not.toContain('prem-claude-sonnet-5.5');
  });

  it('counts each event once, though usage_daily holds cost too', async () => {
    const before = (await get('/api/v1/admin/margin?month=2026-03')).json();
    await admin`select refresh_usage_daily(${alfa}::uuid, '2026-03-01'::date, '2026-03-31'::date)`;
    const [daily] =
      await admin`select sum(cost_usd_micro)::bigint as c from usage_daily where tenant_id = ${alfa}`;
    expect(Number(daily!['c'])).toBe(501_244);
    const after = (await get('/api/v1/admin/margin?month=2026-03')).json();
    expect(after).toEqual(before);
  });

  it('prices seats with the plan version in force that month', async () => {
    await admin`insert into plans (code, version, price_usd_micro, monthly_price_usd_micro, std_tokens,
        prem_tokens, research_runs, files_gb, features, valid_from)
      values ('business', 2, 10000000, 12000000, 6000000, 500000, 40, 5, '{}', '2026-04-01T00:00:00Z')`;
    const march = (await get('/api/v1/admin/margin?month=2026-03')).json();
    expect(march.tenants[0].revenue.seats).toBe(28_800_000);
    const april = (await get('/api/v1/admin/margin?month=2026-04')).json();
    expect(april.tenants[0].revenue.seats).toBe(36_000_000);
    expect(april.tenants[0].cost).toBe(88_000_000);
  });

  it('defaults to this UTC month, and is empty for a month before any company', async () => {
    const now = (await get('/api/v1/admin/margin')).json();
    expect(now.month).toBe(new Date().toISOString().slice(0, 7));
    const early = (await get('/api/v1/admin/margin?month=2025-06')).json();
    expect(early.tenants).toEqual([]);
    expect(early.models).toEqual([]);
    expect(early.total).toMatchObject({ cost: 0, margin: 0, marginPct: null });
  });

  it.each(['2026-13', '2026-3', 'march', '2026-03-01'])('refuses month=%s', async (month) => {
    expect((await get(`/api/v1/admin/margin?month=${month}`)).statusCode).toBe(400);
  });

  it('downloads as a CSV for Excel, in micro-USD', async () => {
    const res = await get('/api/v1/admin/margin/export?month=2026-03&lang=tr');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('margin-2026-03.csv');
    expect(res.body.charCodeAt(0)).toBe(0xfeff);
    const lines = res.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'month;slug;name;status;seats;seat_revenue_usd_micro;addon_revenue_usd_micro;overage_revenue_usd_micro;revenue_usd_micro;provider_cost_usd_micro;margin_usd_micro;margin_pct;revenue_basis',
    );
    expect(lines[1]).toBe(
      '2026-03;alfa;alfa A.Ş.;active;3;28800000;25200000;600000;54600000;501244;54098756;99,1;list_price',
    );
    expect(lines.at(-1)).toBe(
      '2026-03;Toplam;;;6;54800000;25200000;600000;80600000;12501244;68098756;84,5;list_price',
    );
    const en = await get('/api/v1/admin/margin/export?month=2026-03');
    expect(en.body).toContain(';99.1;list_price');
  });

  it('stops a company name running as a formula in the CSV', async () => {
    await admin`update tenants set name = '=HYPERLINK("http://evil.test")' where id = ${beta}`;
    const res = await get('/api/v1/admin/margin/export?month=2026-03');
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil.test"")"`);
  });
});

describe('who can see it', () => {
  it("refuses a company's own admin, and anyone else in a company", async () => {
    for (const bearer of [
      await owner(),
      await token('owner@alfa.test', 'alfa', ['dept_manager']),
      await token('owner@alfa.test', 'alfa', ['user']),
    ]) {
      expect((await get('/api/v1/admin/margin?month=2026-03', bearer)).statusCode).toBe(403);
      expect((await get('/api/v1/admin/margin/export?month=2026-03', bearer)).statusCode).toBe(403);
    }
  });

  it("a company's own usage screens still carry no cost, price or margin", async () => {
    const bearer = await owner();
    const range = 'from=2026-03-01&to=2026-03-31';
    const answers = [
      await get(`/api/v1/tenants/${alfa}/usage?groupBy=model&${range}`, bearer),
      await get(`/api/v1/tenants/${alfa}/usage?groupBy=user&${range}`, bearer),
      await get(`/api/v1/tenants/${alfa}/usage/export?groupBy=dept&${range}`, bearer),
      await get(`/api/v1/tenants/${alfa}/departments/${deptId}/usage?${range}`, bearer),
      await get(`/api/v1/tenants/${alfa}/departments/${deptId}/usage/export?${range}`, bearer),
      await get(`/api/v1/me/usage?${range}`, bearer),
      await get(`/api/v1/tenants/${alfa}/overview`, bearer),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toMatch(/cost|price|margin|revenue/i);
      for (const amount of ['501244', '500000', '600000', '54600000']) {
        expect(res.body).not.toContain(amount);
      }
    }
    // They did show the usage: the tokens are there.
    expect(answers[0]!.json().rows.length).toBeGreaterThan(0);
  });

  it('the console role still reads no cost or price, from either table', async () => {
    const conn = postgres(consoleUrl(), { max: 1 });
    try {
      for (const statement of [
        'select cost_usd_micro from usage_events',
        'select price_usd_micro from usage_events',
        'select cost_usd_micro from usage_daily',
        'select price_in_usd_micro_per_m from model_catalog',
        'select price_usd_micro from plans',
      ]) {
        await expect(conn.unsafe(statement)).rejects.toThrow(/permission denied/);
      }
    } finally {
      await conn.end();
    }
  });

  it("won't run inside a company's transaction, where every company route runs", async () => {
    const conn = postgres(consoleUrl(), { max: 1 });
    try {
      for (const fn of ['provider_margin', 'provider_model_cost']) {
        await expect(
          conn.begin(async (tx) => {
            await tx`select set_config('app.tenant_id', ${alfa}, true)`;
            await tx.unsafe(`select * from ${fn}('2026-03-01'::date)`);
          }),
        ).rejects.toThrow(/provider routes only/);
      }
      // And after that transaction, on the same connection, it runs again.
      const rows = await conn`select slug from provider_margin('2026-03-01'::date)`;
      expect(rows.map((r) => r['slug'])).toEqual(['alfa', 'beta', 'gone']);
    } finally {
      await conn.end();
    }
  });

  it('no other role may call it', async () => {
    const conn = postgres(consoleUrl('katip_gateway', 'gateway-test-password'), { max: 1 });
    try {
      for (const fn of ['provider_margin', 'provider_model_cost']) {
        await expect(conn.unsafe(`select * from ${fn}('2026-03-01'::date)`)).rejects.toThrow(
          /permission denied/,
        );
      }
    } finally {
      await conn.end();
    }
  });
});

describe('the sums', () => {
  it('margin % is to one decimal, and none without revenue', () => {
    expect(marginPct(80_600_000, 68_098_756)).toBe(84.5);
    expect(marginPct(0, -5)).toBeNull();
    expect(marginPct(100, -50)).toBe(-50);
  });

  it('flags cost with no revenue, and a margin under 30%', () => {
    const base = {
      tenantId: 't',
      slug: 's',
      name: 'n',
      status: 'active',
      billingCycle: null,
      seats: 0,
      seatRevenue: 0,
      addonRevenue: 0,
      overageRevenue: 0,
      cost: 0,
      requests: 0,
    };
    const report = marginReport('2026-03', {
      basis: 'list_price',
      models: [],
      tenants: [
        { ...base, slug: 'free', cost: 1 },
        { ...base, slug: 'idle' },
        { ...base, slug: 'thin', seatRevenue: 100, cost: 71 },
        { ...base, slug: 'fine', seatRevenue: 100, cost: 70 },
      ],
    });
    expect(report.tenants.map((t) => [t.slug, t.belowTarget])).toEqual([
      ['free', true],
      ['idle', false],
      ['thin', true],
      ['fine', false],
    ]);
    expect(marginCsv(report)).toContain('2026-03;free;n;active;0;0;0;0;0;1;-1;;list_price');
  });
});
