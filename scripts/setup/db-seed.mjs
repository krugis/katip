// SPDX-License-Identifier: AGPL-3.0-only
// Runs INSIDE the policy-gateway image (node) on the backend network.
// Applies packages/db migrations + seed, then upserts the demo gateway key
// (argon2id) and the tenant's limits and PII policy. All values come from
// katip.config.yaml, through KATIP_SEED (see seedInput in config.mjs).
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (!process.env.KATIP_SEED) throw new Error('KATIP_SEED is required');
const { tenant, limits, pii, models } = JSON.parse(process.env.KATIP_SEED);

const dbPkg = await import('@katip/db');
const sharedPkg = await import('@katip/shared');
const postgres = (await import('postgres')).default;
const { drizzle } = await import('drizzle-orm/postgres-js');
const { migrate, seed } = dbPkg;
const { hashGatewayKey } = sharedPkg;

await migrate(url);
const client = postgres(url, { max: 1 });
const d = drizzle(client, { schema: dbPkg });
await seed(d, { models, tenant });

const key = process.env.KATIP_DEMO_GATEWAY_KEY;
if (!key) throw new Error('KATIP_DEMO_GATEWAY_KEY is required');
const prefix = key.split('-')[3].slice(0, 8);

const rows = await client`select id from tenants where slug = ${tenant.slug}`;
const tenantId = rows[0]?.id;
if (!tenantId) throw new Error(`tenant ${tenant.slug} missing after seed`);

// The tenant has exactly one live gateway key: replace all rows for it.
await client`delete from gateway_keys where tenant_id = ${tenantId}`;
await client`insert into gateway_keys (tenant_id, key_hash, prefix, type)
  values (${tenantId}, ${hashGatewayKey(key)}, ${prefix}, 'tenant')`;

// The bootstrap smoke tests use demo@example.com; ensure it exists.
await client`insert into users (tenant_id, keycloak_id, email, name, role, seat_plan_code, status)
  values (${tenantId}, ${`${tenant.slug}-gateway`}, 'demo@example.com', 'Demo User', 'user', ${tenant.planCode}, 'active')
  on conflict (tenant_id, email) do update set status = 'active'`;

const month = new Date().toISOString().slice(0, 7).replace('-', '');
await client`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
  values (${tenantId}, ${month}, ${limits.standard}, ${limits.premium}, 40)
  on conflict (tenant_id, month) do update
    set std_tokens = excluded.std_tokens, prem_tokens = excluded.prem_tokens`;

// Other policy keys in the row are left alone; only `pii` comes from the config.
await client`insert into tenant_policies (tenant_id, policy)
  values (${tenantId}, ${client.json({ pii })})
  on conflict (tenant_id) do update
    set policy = tenant_policies.policy || excluded.policy`;

await client.end();
console.log('governance db ready: migrated, seeded, demo key stored (argon2id)');
