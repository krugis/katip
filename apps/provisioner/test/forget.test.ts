// SPDX-License-Identifier: AGPL-3.0-only
// One person's deletion, on real Postgres as the role it really connects with. `pnpm
// test:console` runs it against the real stack, with Keycloak, LibreChat and its search index.
import { migrateWithClient, seed } from '@katip/db';
import * as schema from '@katip/db';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deletionLookup, deletionsDue, finishDeletion, type ForgetDeps } from '../src/forget.js';
import { DbProvisionerStore } from '../src/store.js';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>>;
let admin: postgres.Sql;
let store: DbProvisionerStore;
let forgotten: string[] = [];
let failKeycloak = false;

const deps = (): ForgetDeps => ({
  store,
  identity: {
    forgetMember: async (slug, email) => {
      if (failKeycloak) throw new Error('keycloak is down');
      forgotten.push(`keycloak ${slug} ${email}`);
    },
  },
  findLibreChatUser: async () => 'a'.repeat(24),
  forgetLibreChatUser: async (database, id) => {
    forgotten.push(`librechat ${database} ${id}`);
  },
});

let serial = 0;
/** A company with one person who has used it, whose deletion has reached `status`. */
async function person(status = 'approved', tenantStatus = 'active') {
  serial += 1;
  const slug = `forget-${serial}`;
  const [tenant] = await admin`insert into tenants (slug, name, status)
    values (${slug}, ${slug}, ${tenantStatus}) returning id`;
  const tenantId = tenant!['id'] as string;
  const [user] = await admin`insert into users (tenant_id, keycloak_id, email, name)
    values (${tenantId}, ${`kc-${slug}`}, ${`ayse@${slug}.test`}, 'Ayşe Yılmaz') returning id`;
  const userId = user!['id'] as string;
  const [other] = await admin`insert into users (tenant_id, keycloak_id, email, name)
    values (${tenantId}, ${`kc2-${slug}`}, ${`ali@${slug}.test`}, 'Ali Kaya') returning id`;
  const [request] = await admin`insert into privacy_requests (tenant_id, user_id, type, status)
    values (${tenantId}, ${userId}, 'delete', ${status}) returning id`;
  await admin`insert into privacy_requests (tenant_id, user_id, type, status, file_url)
    values (${tenantId}, ${userId}, 'export', 'completed', 'https://files/ayse.zip')`;
  await admin`insert into requests (tenant_id, user_id, type, payload)
    values (${tenantId}, ${userId}, 'model', ${JSON.stringify({ reason: 'Ayşe istiyor' })}::jsonb)`;
  await admin`insert into requests (tenant_id, user_id, type, payload)
    values (${tenantId}, ${other!['id'] as string}, 'model', ${JSON.stringify({ reason: 'Ali' })}::jsonb)`;
  return {
    slug,
    tenantId,
    userId,
    otherId: other!['id'] as string,
    requestId: request!['id'] as string,
  };
}

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
}, 240_000);

afterAll(async () => {
  await store?.close();
  await admin?.end();
  await container?.stop();
});

describe("one person's deletion", () => {
  it('lists only approved deletions in companies that are running', async () => {
    const yes = await person();
    const waiting = await person('pending');
    const suspended = await person('approved', 'suspended');
    const listed = await deletionsDue(deps());
    expect(listed).toContainEqual({ slug: yes.slug, requestId: yes.requestId });
    expect(listed.map((d) => d.slug)).not.toContain(waiting.slug);
    expect(listed.map((d) => d.slug)).not.toContain(suspended.slug);
  });

  it('refuses a request nobody has approved, or from another company', async () => {
    const waiting = await person('pending');
    await expect(deletionLookup(deps(), waiting.slug, waiting.requestId)).rejects.toThrow(
      /no approved deletion/,
    );
    const mine = await person();
    await expect(finishDeletion(deps(), waiting.slug, mine.requestId)).rejects.toThrow(
      /no approved deletion/,
    );
  });

  it('leaves nothing that identifies them, and nobody else is touched', async () => {
    forgotten = [];
    const p = await person();
    const event = { tenantId: p.tenantId, userId: p.userId };
    await admin`insert into usage_events
      (id, tenant_id, user_id, alias, model_id, class, input_tokens, output_tokens,
       cost_usd_micro, price_usd_micro, source)
      values (gen_random_uuid(), ${event.tenantId}, ${event.userId}, 'fast', 'm', 'standard',
       7, 3, 0, 0, 'chat')`;

    await finishDeletion(deps(), p.slug, p.requestId);

    expect(forgotten).toEqual([
      `librechat lc_${p.slug} ${'a'.repeat(24)}`,
      `keycloak ${p.slug} ayse@${p.slug}.test`,
    ]);
    const [gone] = await admin`select * from users where id = ${p.userId}`;
    expect(gone).toMatchObject({
      email: `deleted-${p.userId}@deleted.invalid`,
      name: 'Deleted user',
      keycloak_id: `deleted-${p.userId}`,
      status: 'deleted',
    });
    const everything = JSON.stringify([
      await admin`select * from users where tenant_id = ${p.tenantId} and id = ${p.userId}`,
      await admin`select * from requests where user_id = ${p.userId}`,
      await admin`select * from privacy_requests where user_id = ${p.userId}`,
    ]);
    expect(everything).not.toContain('Ayşe');
    expect(everything).not.toContain('ayse');
    const [request] = await admin`select status, completed_at from privacy_requests
      where id = ${p.requestId}`;
    expect(request!['status']).toBe('completed');
    expect(request!['completed_at']).not.toBeNull();

    const [usage] = await admin`select input_tokens from usage_events where user_id = ${p.userId}`;
    expect(Number(usage!['input_tokens'])).toBe(7);

    const [other] = await admin`select email, status from users where id = ${p.otherId}`;
    expect(other).toMatchObject({ email: `ali@${p.slug}.test`, status: 'active' });
    const [theirs] = await admin`select payload from requests where user_id = ${p.otherId}`;
    expect(theirs!['payload']).toEqual({ reason: 'Ali' });

    const [entry] = await admin`select action, details from audit_log
      where target_id = ${p.userId} order by ts desc limit 1`;
    expect(entry!['action']).toBe('privacy.delete_done');
    expect(JSON.stringify(entry!['details'])).not.toContain('ayse');
  });

  it('is not listed again once done', async () => {
    const p = await person();
    await finishDeletion(deps(), p.slug, p.requestId);
    expect((await deletionsDue(deps())).map((d) => d.slug)).not.toContain(p.slug);
    await expect(finishDeletion(deps(), p.slug, p.requestId)).rejects.toThrow(/no approved/);
  });

  it('keeps the email until the end, so a run that stops part-way can be repeated', async () => {
    const p = await person();
    failKeycloak = true;
    await expect(finishDeletion(deps(), p.slug, p.requestId)).rejects.toThrow('keycloak');
    failKeycloak = false;
    const [still] = await admin`select email from users where id = ${p.userId}`;
    expect(still!['email']).toBe(`ayse@${p.slug}.test`);
    await finishDeletion(deps(), p.slug, p.requestId);
    const [gone] = await admin`select status from users where id = ${p.userId}`;
    expect(gone!['status']).toBe('deleted');
  });
});
