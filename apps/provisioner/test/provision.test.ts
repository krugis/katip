// SPDX-License-Identifier: AGPL-3.0-only
// tenant:create on real Postgres, as the role it really connects with. Keycloak and Mongo
// are stand-ins here; dev:up runs the same steps against the real ones on every install.
import { forgetUnfinishedTenant, migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { generateGatewayKey, verifyKey } from '@katip/shared';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTenant,
  finishTenant,
  rollbackTenant,
  type IdentityAdmin,
  type ProvisionDeps,
  type TenantSecrets,
} from '../src/provision.js';
import { DbProvisionerStore } from '../src/store.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let provider: postgres.Sql;
let store: DbProvisionerStore;
let secrets: TenantSecrets;

/** Records calls, and can fail at one point to test finishing a failed attempt. */
class FakeIdentity implements IdentityAdmin {
  invites = 0;
  admins = 0;
  orgs = new Set<string>();
  failOnce: 'identity' | 'invite' | null = null;
  async ensureTenantIdentity(input: { slug: string }): Promise<boolean> {
    if (this.failOnce === 'identity') {
      this.failOnce = null;
      throw new Error('keycloak is down, Authorization: Bearer secret-value');
    }
    const isNew = !this.orgs.has(input.slug);
    this.orgs.add(input.slug);
    return isNew;
  }
  async ensureAdmin(): Promise<{ id: string }> {
    this.admins += 1;
    return { id: `kc-${this.admins}-${Math.random().toString(16).slice(2)}` };
  }
  async removeTenantIdentity(input: { slug: string }): Promise<void> {
    this.orgs.delete(input.slug);
  }
  async sendInvite(): Promise<void> {
    if (this.failOnce === 'invite') {
      this.failOnce = null;
      throw new Error('smtp is down');
    }
    this.invites += 1;
  }
}

let identity: FakeIdentity;
let mongo: Map<string, string>;
const deps = () => ({
  store,
  identity,
  ensureMongoUser: async (db: string, password: string) => {
    const created = !mongo.has(db);
    mongo.set(db, password);
    return created;
  },
  dropMongoDatabase: async (db: string) => {
    mongo.delete(db);
  },
});
/** The stages in order, with the host's start of LibreChat between them left out. */
const provision = async (d: ProvisionDeps, raw: unknown, s: TenantSecrets) => {
  const a = await createTenant(d, raw, s);
  const b = await finishTenant(d, raw, a.changedSteps);
  const changedSteps = [...a.changedSteps, ...b.changedSteps];
  return { alreadyExists: changedSteps.length === 0, changedSteps };
};
const input = (slug: string, over: object = {}) => ({
  slug,
  name: 'Acme A.Ş.',
  planCode: 'business',
  seats: 10,
  adminEmail: `owner@${slug}.test`,
  baseDomain: 'test',
  ...over,
});
const count = async (table: string, slug: string) => {
  const rows = await admin.unsafe(
    `select count(*)::int as n from ${table} where tenant_id = (select id from tenants where slug = '${slug}')`,
  );
  return rows[0]!['n'] as number;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await seed(drizzle(admin, { schema }), { tenant: null });
  await admin.unsafe(`ALTER ROLE katip_provider PASSWORD 'provider-test-password'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'katip_provider';
  url.password = 'provider-test-password';
  provider = postgres(url.toString(), { max: 1 });
  store = new DbProvisionerStore(url.toString());
  const key = await generateGatewayKey('tenant');
  secrets = { gatewayKey: key.key, oidcClientSecret: 'oidc', mongoPassword: 'mongo' };
}, 240_000);

afterAll(async () => {
  await store?.close();
  await provider?.end();
  await admin?.end();
  await container?.stop();
});

beforeEach(() => {
  identity = new FakeIdentity();
  mongo = new Map();
});

describe('tenant:create', () => {
  it('creates the tenant with everything it needs', async () => {
    const r = await provision(deps(), input('acme-one'), secrets);
    expect(r.alreadyExists).toBe(false);
    expect(r.changedSteps).toEqual([
      'governance-db',
      'keycloak',
      'mongodb',
      'gateway-key',
      'tenant-admin',
    ]);
    for (const table of [
      'subscriptions',
      'seats',
      'tenant_policies',
      'access_rules',
      'tenant_limits',
      'users',
      'gateway_keys',
    ]) {
      expect(await count(table, 'acme-one'), table).toBe(1);
    }
    expect(identity.invites).toBe(1);
    expect(mongo.get('lc_acme-one')).toBe('mongo');
  });

  it('invites nobody until the last stage', async () => {
    const d = deps();
    await createTenant(d, input('acme-order'), secrets);
    expect(identity.invites).toBe(0);
    expect(await count('users', 'acme-order')).toBe(0);
    expect(await count('audit_log', 'acme-order')).toBe(0);
    await finishTenant(d, input('acme-order'), ['governance-db']);
    expect(identity.invites).toBe(1);
    expect(await count('audit_log', 'acme-order')).toBe(1);
  });

  it('a failed first attempt leaves nothing, and a re-run starts clean', async () => {
    const d = deps();
    await createTenant(d, input('acme-undo'), secrets);
    await rollbackTenant(d, input('acme-undo'), 'start');
    expect(mongo.has('lc_acme-undo')).toBe(false);
    expect(identity.orgs.has('acme-undo')).toBe(false);
    await forgetUnfinishedTenant(admin, 'acme-undo');
    expect(await admin`select id from tenants where slug = 'acme-undo'`).toHaveLength(0);
    const jobs = await admin`select type, status, result, tenant_id from jobs
      where payload->>'slug' = 'acme-undo' order by created_at`;
    expect(jobs.map((j) => j['type'])).toEqual(['tenant.create', 'tenant.rollback']);
    expect(jobs[1]!['result']).toEqual({ failedStep: 'start' });
    expect(jobs.every((j) => j['tenant_id'] === null)).toBe(true);

    const again = await provision(d, input('acme-undo', { seats: 7 }), secrets);
    expect(again.changedSteps).toContain('governance-db');
    const [seats] = await admin`select s.quantity from seats s join tenants t on t.id = s.tenant_id
      where t.slug = 'acme-undo'`;
    expect(seats!['quantity']).toBe(7);
  });

  it('never rolls back a tenant that has users', async () => {
    const d = deps();
    await provision(d, input('acme-live'), secrets);
    await expect(rollbackTenant(d, input('acme-live'), 'start')).rejects.toThrow(/has users/);
    expect(mongo.has('lc_acme-live')).toBe(true);
    expect(identity.orgs.has('acme-live')).toBe(true);
    await expect(forgetUnfinishedTenant(admin, 'acme-live')).rejects.toThrow(/has users/);
    expect(await admin`select id from tenants where slug = 'acme-live'`).toHaveLength(1);
  });

  it('pools the plan quota across the seats', async () => {
    await provision(deps(), input('acme-limits', { seats: 3 }), secrets);
    const [row] = await admin`select l.std_tokens::bigint as std, p.std_tokens::bigint as per_seat
      from tenant_limits l join tenants t on t.id = l.tenant_id
      join plans p on p.code = 'business'
      where t.slug = 'acme-limits'`;
    expect(Number(row!['std'])).toBe(Number(row!['per_seat']) * 3);
  });

  it('applies MFA and the default countries', async () => {
    await provision(deps(), input('acme-rules'), secrets);
    const [row] = await admin`select r.mfa_required, r.countries from access_rules r
      join tenants t on t.id = r.tenant_id where t.slug = 'acme-rules'`;
    expect(row!['mfa_required']).toBe(true);
    expect(row!['countries']).toContain('TR');
    expect(row!['countries']).toContain('DE');
  });

  it('stores only the hash of the gateway key', async () => {
    await provision(deps(), input('acme-key'), secrets);
    const [row] =
      await admin`select k.key_hash from gateway_keys k join tenants t on t.id = k.tenant_id
      where t.slug = 'acme-key'`;
    expect(row!['key_hash']).not.toContain(secrets.gatewayKey);
    expect(await verifyKey(secrets.gatewayKey, row!['key_hash'] as string)).toBe(true);
  });

  it('a second run changes nothing and says so', async () => {
    const first = deps();
    await provision(first, input('acme-twice'), secrets);
    const invites = identity.invites;
    const again = await provision(first, input('acme-twice'), secrets);
    expect(again.alreadyExists).toBe(true);
    expect(again.changedSteps).toEqual([]);
    expect(identity.invites).toBe(invites);
    for (const table of ['subscriptions', 'seats', 'users', 'gateway_keys']) {
      expect(await count(table, 'acme-twice'), table).toBe(1);
    }
    const audits = await count('audit_log', 'acme-twice');
    expect(audits).toBe(1);
  });

  it('a re-run with another email adds no second admin', async () => {
    const d = deps();
    await provision(d, input('acme-email'), secrets);
    const r = await provision(d, input('acme-email', { adminEmail: 'someone@else.test' }), secrets);
    expect(r.alreadyExists).toBe(true);
    expect(identity.invites).toBe(1);
    expect(await count('users', 'acme-email')).toBe(1);
  });

  it('a re-run finishes an attempt that failed at Keycloak', async () => {
    identity.failOnce = 'identity';
    const d = deps();
    await expect(provision(d, input('acme-resume'), secrets)).rejects.toThrow(/step keycloak/);
    const [failed] = await admin`select status, result from jobs
      where payload->>'slug' = 'acme-resume' order by created_at desc limit 1`;
    expect(failed!['status']).toBe('failed');
    expect(failed!['result']).toEqual({ step: 'keycloak' });

    const r = await provision(d, input('acme-resume'), secrets);
    expect(r.alreadyExists).toBe(false);
    expect(r.changedSteps).not.toContain('governance-db');
    expect(identity.invites).toBe(1);
    expect(await count('seats', 'acme-resume')).toBe(1);
  });

  it('a re-run sends the invite if it failed the first time, and only once', async () => {
    identity.failOnce = 'invite';
    const d = deps();
    await expect(provision(d, input('acme-invite'), secrets)).rejects.toThrow(/step tenant-admin/);
    expect(await count('users', 'acme-invite')).toBe(0);
    await provision(d, input('acme-invite'), secrets);
    expect(identity.invites).toBe(1);
    expect(await count('users', 'acme-invite')).toBe(1);
    await provision(d, input('acme-invite'), secrets);
    expect(identity.invites).toBe(1);
  });

  it("does not keep a failed call's message in the job", async () => {
    identity.failOnce = 'identity';
    await expect(provision(deps(), input('acme-secret'), secrets)).rejects.toThrow();
    const rows = await admin`select result from jobs where payload->>'slug' = 'acme-secret'`;
    expect(JSON.stringify(rows)).not.toContain('secret-value');
  });

  it('replaces a gateway key that no longer matches the secrets file', async () => {
    const d = deps();
    await provision(d, input('acme-rotate'), secrets);
    const next = await generateGatewayKey('tenant');
    const r = await provision(d, input('acme-rotate'), { ...secrets, gatewayKey: next.key });
    expect(r.changedSteps).toEqual(['gateway-key']);
    const rows =
      await admin`select revoked_at from gateway_keys k join tenants t on t.id = k.tenant_id
      where t.slug = 'acme-rotate' order by k.created_at`;
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row['revoked_at'] === null)).toHaveLength(1);
  });

  it('keeps tenants apart', async () => {
    const d = deps();
    await provision(d, input('acme-a'), secrets);
    await provision(d, input('acme-b'), secrets);
    expect(mongo.has('lc_acme-a')).toBe(true);
    expect(mongo.has('lc_acme-b')).toBe(true);
    expect(await count('users', 'acme-a')).toBe(1);
  });

  it.each([
    ['a short slug', { slug: 'ab' }],
    ['a slug with capitals', { slug: 'Acme' }],
    ['a reserved slug', { slug: 'auth' }],
    ['the provider organization', { slug: 'provider' }],
    ['no seats', { seats: 0 }],
    ['a bad admin email', { adminEmail: 'not-an-email' }],
  ])('refuses %s, without creating anything', async (_label, over) => {
    await expect(provision(deps(), input('acme-bad', over), secrets)).rejects.toThrow();
    expect(await admin`select id from tenants where slug = 'acme-bad'`).toHaveLength(0);
  });

  it('refuses an unknown plan, and leaves no tenant behind', async () => {
    await expect(
      provision(deps(), input('acme-plan', { planCode: 'nope' }), secrets),
    ).rejects.toThrow(/step governance-db.*unknown plan/);
    expect(await admin`select id from tenants where slug = 'acme-plan'`).toHaveLength(0);
  });
});

describe('the provisioner role', () => {
  it('is not a superuser', async () => {
    const [r] = await admin`select rolsuper from pg_roles where rolname = 'katip_provider'`;
    expect(r!['rolsuper']).toBe(false);
  });

  it.each([
    ['read usage', `select * from usage_events`],
    ['read invoices', `select * from invoices`],
    ['change plans', `update plans set std_tokens = 1`],
    ['change the catalog', `update model_catalog set enabled = false`],
    ['delete tenants', `delete from tenants`],
    ['change the audit log', `update audit_log set action = 'x'`],
    ['delete users', `delete from users`],
    ['drop a table', `drop table users`],
  ])('is denied: %s', async (_label, statement) => {
    await expect(provider.unsafe(statement)).rejects.toThrow(/permission denied|must be owner/);
  });
});
