// SPDX-License-Identifier: AGPL-3.0-only
// Runs INSIDE the policy-gateway image (node) on the backend network.
// Applies packages/db migrations + seed, then upserts the demo gateway key
// (argon2id) and current-month tenant limits from katip.config.yaml.
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');

const dbPkg = await import('@katip/db');
const sharedPkg = await import('@katip/shared');
const postgres = (await import('postgres')).default;
const { drizzle } = await import('drizzle-orm/postgres-js');
const { migrate, seed, schema } = dbPkg;
const { hashGatewayKey } = sharedPkg;

await migrate(url);
const client = postgres(url, { max: 1 });
const d = drizzle(client, { schema });
await seed(d);

const key = process.env.KATIP_DEMO_GATEWAY_KEY;
if (!key) throw new Error('KATIP_DEMO_GATEWAY_KEY is required');
const prefix = key.split('-')[3].slice(0, 8);

const rows = await client`select id from tenants where slug = 'demo'`;
const tenantId = rows[0]?.id;
if (!tenantId) throw new Error('demo tenant missing after seed');

// The demo tenant has exactly one live gateway key: replace all rows for it.
await client`delete from gateway_keys where tenant_id = ${tenantId}`;
await client`insert into gateway_keys (tenant_id, key_hash, prefix, type)
  values (${tenantId}, ${hashGatewayKey(key)}, ${prefix}, 'tenant')`;

// The bootstrap smoke tests use demo@example.com; ensure it exists.
await client`insert into users (tenant_id, keycloak_id, email, name, role, seat_plan_code, status)
  values (${tenantId}, 'demo-gateway', 'demo@example.com', 'Demo User', 'user', 'business', 'active')
  on conflict (tenant_id, email) do update set status = 'active'`;

const month = new Date().toISOString().slice(0, 7).replace('-', '');
const std = Number(process.env.KATIP_TENANT_STD_LIMITS ?? 0);
const prem = Number(process.env.KATIP_TENANT_PREM_LIMITS ?? 0);
await client`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
  values (${tenantId}, ${month}, ${std}, ${prem}, 40)
  on conflict (tenant_id, month) do update
    set std_tokens = excluded.std_tokens, prem_tokens = excluded.prem_tokens`;

await client.end();
console.log('governance db ready: migrated, seeded, demo key stored (argon2id)');
