// SPDX-License-Identifier: AGPL-3.0-only
// The lifecycle on real Postgres, as the role it really connects with. `pnpm test:lifecycle`
// runs it against the real stack.
import { migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { generateGatewayKey } from '@katip/shared';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTenant,
  finishPurge,
  purgesDue,
  resumeTenant,
  startPurge,
  suspendTenant,
  type LifecycleDeps,
} from '../src/lifecycle.js';
import {
  createTenant,
  finishTenant,
  type ProvisionDeps,
  type TenantSecrets,
} from '../src/provision.js';
import { DbProvisionerStore } from '../src/store.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let store: DbProvisionerStore;
let secrets: TenantSecrets;
let purgedIdentities: string[];
let droppedDatabases: string[];

const DAY = 86_400_000;
const later = (days: number) => new Date(Date.now() + days * DAY);

const deps = (): LifecycleDeps => ({
  store,
  identity: {
    purgeTenantIdentity: async (slug) => {
      purgedIdentities.push(slug);
    },
  },
  dropMongoDatabase: async (db) => {
    droppedDatabases.push(db);
  },
});

const make = async (slug: string) => {
  const d: ProvisionDeps = {
    store,
    identity: {
      ensureTenantIdentity: async () => true,
      ensureAdmin: async () => ({ id: `kc-${slug}` }),
      sendInvite: async () => undefined,
      removeTenantIdentity: async () => undefined,
      purgeTenantIdentity: async () => undefined,
    },
    ensureMongoUser: async () => true,
    dropMongoDatabase: async () => undefined,
  };
  const input = {
    slug,
    name: 'Acme',
    planCode: 'business',
    seats: 2,
    adminEmail: `owner@${slug}.test`,
    baseDomain: 'test',
  };
  await createTenant(d, input, secrets);
  await finishTenant(d, input);
  return { provisionDeps: d, input };
};

const status = async (slug: string) =>
  (await admin`select status from tenants where slug = ${slug}`)[0]!['status'];
const actions = async (slug: string) =>
  (await admin`select action from audit_log where target_id = ${slug} order by ts`).map(
    (r) => r['action'],
  );

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16.9-alpine').start();
  admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} });
  await migrateWithClient(admin);
  await seed(drizzle(admin, { schema }), { tenant: null });
  await admin.unsafe(`ALTER ROLE katip_provider PASSWORD 'provider-test-password'`);
  const url = new URL(container.getConnectionUri());
  url.username = 'katip_provider';
  url.password = 'provider-test-password';
  store = new DbProvisionerStore(url.toString());
  const key = await generateGatewayKey('tenant');
  secrets = { gatewayKey: key.key, oidcClientSecret: 'oidc', mongoPassword: 'mongo' };
}, 240_000);

afterAll(async () => {
  await store?.close();
  await admin?.end();
  await container?.stop();
});

beforeEach(() => {
  purgedIdentities = [];
  droppedDatabases = [];
});

describe('suspend and resume', () => {
  it('moves between the states, and audits each change once', async () => {
    await make('life-susp');
    expect(await suspendTenant(deps(), 'life-susp')).toEqual({ changed: true });
    expect(await status('life-susp')).toBe('suspended');
    expect(await suspendTenant(deps(), 'life-susp')).toEqual({ changed: false });
    expect(await resumeTenant(deps(), 'life-susp')).toEqual({ changed: true });
    expect(await status('life-susp')).toBe('active');
    expect(await resumeTenant(deps(), 'life-susp')).toEqual({ changed: false });
    expect(await actions('life-susp')).toEqual([
      'tenant.create',
      'tenant.suspend',
      'tenant.resume',
    ]);
  });

  it('refuses a tenant that does not exist', async () => {
    await expect(suspendTenant(deps(), 'life-none')).rejects.toThrow(/does not exist/);
  });

  it('refuses to create over a suspended tenant', async () => {
    const { provisionDeps, input } = await make('life-block');
    await suspendTenant(deps(), 'life-block');
    await expect(createTenant(provisionDeps, input, secrets)).rejects.toThrow(/is suspended/);
  });
});

describe('delete', () => {
  it('locks out now, and schedules the purge 30 days away', async () => {
    await make('life-del');
    const now = new Date();
    const r = await deleteTenant(deps(), 'life-del', now);
    expect(r.changed).toBe(true);
    expect(new Date(r.purgeAfter!).getTime()).toBe(now.getTime() + 30 * DAY);
    expect(await status('life-del')).toBe('deleted');
    expect(droppedDatabases).toEqual([]);
  });

  it('a second delete keeps the original date', async () => {
    await make('life-del2');
    const first = await deleteTenant(deps(), 'life-del2');
    const second = await deleteTenant(deps(), 'life-del2', later(5));
    expect(second).toEqual({ changed: false, purgeAfter: first.purgeAfter });
  });

  it('can be restored during the wait, which cancels the purge', async () => {
    await make('life-back');
    await deleteTenant(deps(), 'life-back');
    expect((await resumeTenant(deps(), 'life-back')).changed).toBe(true);
    expect(await status('life-back')).toBe('active');
    expect(await purgesDue(deps(), later(31))).not.toContain('life-back');
    await expect(startPurge(deps(), 'life-back', later(31))).rejects.toThrow(/not due/);
    expect((await actions('life-back')).at(-1)).toBe('tenant.restore');
  });

  it('can be deleted again after a restore, with a new date', async () => {
    await make('life-again');
    await deleteTenant(deps(), 'life-again');
    await resumeTenant(deps(), 'life-again');
    const again = await deleteTenant(deps(), 'life-again', later(10));
    expect(again.changed).toBe(true);
    expect(await purgesDue(deps(), later(35))).not.toContain('life-again');
    expect(await purgesDue(deps(), later(41))).toContain('life-again');
  });

  it('refuses to create over a deleted tenant', async () => {
    const { provisionDeps, input } = await make('life-slug');
    await deleteTenant(deps(), 'life-slug');
    await expect(createTenant(provisionDeps, input, secrets)).rejects.toThrow(/is deleted/);
  });

  it('cannot suspend a deleted tenant', async () => {
    await make('life-dsus');
    await deleteTenant(deps(), 'life-dsus');
    await expect(suspendTenant(deps(), 'life-dsus')).rejects.toThrow(/has been deleted/);
  });
});

describe('purge', () => {
  it('runs only when due', async () => {
    await make('life-early');
    await deleteTenant(deps(), 'life-early');
    expect(await purgesDue(deps(), later(29))).not.toContain('life-early');
    await expect(startPurge(deps(), 'life-early', later(29))).rejects.toThrow(/not due/);
    expect(await purgesDue(deps(), later(31))).toContain('life-early');
  });

  it('never purges a tenant that was not deleted', async () => {
    await make('life-live');
    await expect(startPurge(deps(), 'life-live', later(100))).rejects.toThrow(/not due/);
    await expect(finishPurge(deps(), 'life-live')).rejects.toThrow(/no purge in progress/);
    expect(droppedDatabases).toEqual([]);
  });

  it('destroys chats and logins, and anonymises what stays', async () => {
    await make('life-purge');
    const [row] = await admin`select id from tenants where slug = 'life-purge'`;
    const id = row!['id'] as string;
    const [user] = await admin`select id from users where tenant_id = ${id}`;
    await admin`insert into requests (tenant_id, user_id, type, payload)
      values (${id}, ${user!['id'] as string}, 'model', ${JSON.stringify({ reason: 'Ayşe needs it' })}::jsonb)`;
    await admin`insert into privacy_requests (tenant_id, user_id, type, file_url)
      values (${id}, ${user!['id'] as string}, 'export', 'https://files/export-ayse.zip')`;

    await deleteTenant(deps(), 'life-purge');
    await startPurge(deps(), 'life-purge', later(31));
    await expect(resumeTenant(deps(), 'life-purge')).rejects.toThrow(/purged/);
    await finishPurge(deps(), 'life-purge');

    expect(droppedDatabases).toEqual(['lc_life-purge']);
    expect(purgedIdentities).toEqual(['life-purge']);

    const [u] =
      await admin`select email, name, keycloak_id, status from users where tenant_id = ${id}`;
    expect(u!['email']).toMatch(/^deleted-.*@deleted\.invalid$/);
    expect(u!['name']).toBe('Deleted user');
    expect(u!['keycloak_id']).toMatch(/^deleted-/);
    expect(u!['status']).toBe('disabled');
    expect(JSON.stringify(await admin`select * from users where tenant_id = ${id}`)).not.toContain(
      'life-purge.test',
    );

    const [req] = await admin`select payload from requests where tenant_id = ${id}`;
    expect(req!['payload']).toEqual({});
    const [priv] = await admin`select file_url from privacy_requests where tenant_id = ${id}`;
    expect(priv!['file_url']).toBeNull();
    const live =
      await admin`select 1 from gateway_keys where tenant_id = ${id} and revoked_at is null`;
    expect(live).toHaveLength(0);

    expect(await status('life-purge')).toBe('deleted');
    expect((await actions('life-purge')).slice(-1)).toEqual(['tenant.purge']);
    expect(await purgesDue(deps(), later(100))).not.toContain('life-purge');
    await expect(resumeTenant(deps(), 'life-purge')).rejects.toThrow(/purged/);
    await expect(deleteTenant(deps(), 'life-purge')).resolves.toMatchObject({ changed: false });
  });

  it('can be repeated if it stopped part-way', async () => {
    await make('life-retry');
    await deleteTenant(deps(), 'life-retry');
    await startPurge(deps(), 'life-retry', later(31));
    const failing: LifecycleDeps = {
      ...deps(),
      dropMongoDatabase: async () => {
        throw new Error('mongo is down');
      },
    };
    await expect(finishPurge(failing, 'life-retry')).rejects.toThrow(/mongo is down/);
    expect(await purgesDue(deps(), later(31))).toContain('life-retry');
    await startPurge(deps(), 'life-retry', later(31));
    await finishPurge(deps(), 'life-retry');
    expect(await purgesDue(deps(), later(31))).not.toContain('life-retry');
  });

  it('keeps the slug taken for good', async () => {
    const { provisionDeps, input } = await make('life-gone');
    await deleteTenant(deps(), 'life-gone');
    await startPurge(deps(), 'life-gone', later(31));
    await finishPurge(deps(), 'life-gone');
    await expect(createTenant(provisionDeps, input, secrets)).rejects.toThrow(/is deleted/);
    expect(await admin`select id from tenants where slug = 'life-gone'`).toHaveLength(1);
  });

  it('leaves other tenants alone', async () => {
    await make('life-keep');
    await make('life-drop');
    await deleteTenant(deps(), 'life-drop');
    await startPurge(deps(), 'life-drop', later(31));
    await finishPurge(deps(), 'life-drop');
    const [u] =
      await admin`select u.email, u.status from users u join tenants t on t.id = u.tenant_id
      where t.slug = 'life-keep'`;
    expect(u!['email']).toBe('owner@life-keep.test');
    expect(u!['status']).toBe('active');
    expect(await status('life-keep')).toBe('active');
    const keys = await admin`select 1 from gateway_keys k join tenants t on t.id = k.tenant_id
      where t.slug = 'life-keep' and k.revoked_at is null`;
    expect(keys).toHaveLength(1);
  });
});
