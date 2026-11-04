// SPDX-License-Identifier: AGPL-3.0-only
// Runs INSIDE the policy-gateway image (node) on the backend network, in two stages.
//   platform: migrations, roles, plans, model catalog and router rules
//   tenants:  dev only, after provisioning: demo users, and the seats, limits and PII policy
//             from katip.config.yaml, so editing them there takes effect on a re-run
//   forget:   removes the rows of a tenant whose first creation failed
// Input comes through KATIP_SEED (see seedInput in config.mjs).
const stage = process.argv[2];
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (!process.env.KATIP_SEED) throw new Error('KATIP_SEED is required');
const { tenants, models } = JSON.parse(process.env.KATIP_SEED);

const dbPkg = await import('@katip/db');
const postgres = (await import('postgres')).default;
const { drizzle } = await import('drizzle-orm/postgres-js');
const { forgetUnfinishedTenant, migrate, seed } = dbPkg;

const client = postgres(url, { max: 1 });
const d = drizzle(client, { schema: dbPkg });

/** Services run as limited roles, each with its own password (LLD-05 §1). */
async function setRolePassword(role, password = '') {
  if (!/^[\w-]{32,}$/.test(password)) {
    throw new Error(`the password for ${role} is missing or has the wrong format`);
  }
  await client.unsafe(`ALTER ROLE ${role} PASSWORD '${password}'`);
}

if (stage === 'platform') {
  await migrate(url);
  await setRolePassword('katip_gateway', process.env.KATIP_GATEWAY_DB_PASSWORD);
  await setRolePassword('katip_console', process.env.KATIP_CONSOLE_DB_PASSWORD);
  await setRolePassword('katip_provider', process.env.KATIP_PROVIDER_DB_PASSWORD);
  await setRolePassword('katip_billing', process.env.KATIP_BILLING_DB_PASSWORD);
  await seed(d, { models, tenant: null });
  console.log('governance db ready: migrated, roles set, catalog seeded');
} else if (stage === 'tenants') {
  for (const { tenant, limits, pii, smokeEmail } of tenants) {
    await seed(d, { models, tenant });

    const rows = await client`select id from tenants where slug = ${tenant.slug}`;
    const tenantId = rows[0]?.id;
    if (!tenantId) throw new Error(`tenant ${tenant.slug} is missing: provision it first`);

    // The bootstrap smoke tests use demo@example.com; ensure it exists.
    await client`insert into users (tenant_id, keycloak_id, email, name, role, seat_plan_code, status)
      values (${tenantId}, ${`${tenant.slug}-gateway`}, 'demo@example.com', 'Demo User', 'user', ${tenant.planCode}, 'active')
      on conflict (tenant_id, email) do update set status = 'active'`;

    // The smoke test's chat goes through the gateway, which only serves known users.
    await client`insert into users (tenant_id, keycloak_id, email, name, role, seat_plan_code, status)
      values (${tenantId}, ${`${tenant.slug}-smoke`}, ${smokeEmail}, 'Smoke Test', 'user', ${tenant.planCode}, 'active')
      on conflict (tenant_id, email) do update set status = 'active'`;

    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    await client`insert into tenant_limits (tenant_id, month, std_tokens, prem_tokens, research_runs)
      values (${tenantId}, ${month}, ${limits.standard}, ${limits.premium}, 40)
      on conflict (tenant_id, month) do update
        set std_tokens = excluded.std_tokens, prem_tokens = excluded.prem_tokens`;

    // Other policy keys in the row are left alone; only `pii` comes from the config.
    await client`insert into tenant_policies (tenant_id, policy)
      values (${tenantId}, ${JSON.stringify({ pii })}::jsonb)
      on conflict (tenant_id) do update
        set policy = tenant_policies.policy || excluded.policy`;
  }
  console.log(`${tenants.length} dev tenants seeded`);
} else if (stage === 'forget') {
  await forgetUnfinishedTenant(client, process.argv[3]);
  console.log(`rows of ${process.argv[3]} removed`);
} else {
  throw new Error(`unknown stage: ${stage}`);
}

await client.end();
