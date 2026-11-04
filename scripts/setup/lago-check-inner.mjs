// SPDX-License-Identifier: AGPL-3.0-only
// Runs INSIDE the billing-bridge image, started by lago-check.mjs on its throwaway networks. It
// does what the test needs done to the governance DB, as the admin role, and reads Lago.
// Made-up companies and usage only. Prints one line `check-result=<json>`.
//   prepare: migrate, seed, two companies with seats and overage usage in closed hours
//   late:    more usage, in an hour already sent
//   seats:   the demo company buys two more seats
//   replay:  every row pending again, as if every answer from Lago had been lost
//   lago:    Lago's current usage for both companies
//   sent:    the rows billing-bridge recorded
import postgres from 'postgres';
import { migrate, seedFromUrl } from '@katip/db';
import { LagoClient } from './dist/lago.js';

const phase = process.argv[2];
const adminUrl = process.env.ADMIN_DATABASE_URL;
const sql = postgres(adminUrl, { max: 1, onnotice: () => {} });
const hourAgo = (n) => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - n * 3_600_000);
const at = (hour, minutes) => new Date(hour.getTime() + minutes * 60_000);
const tenantId = async (slug) => (await sql`select id from tenants where slug = ${slug}`)[0].id;

async function usage(slug, rows) {
  const t = await tenantId(slug);
  const [u] = await sql`select id from users where tenant_id = ${t} order by email limit 1`;
  for (const [ts, cls, input, output, overage] of rows) {
    await sql`insert into usage_events (id, tenant_id, user_id, ts, alias, model_id, class,
        input_tokens, output_tokens, cost_usd_micro, price_usd_micro, source, overage)
      values (gen_random_uuid(), ${t}, ${u.id}, ${ts}, 'fast', 'lago-check', ${cls}, ${input},
        ${output}, 1, 1, 'chat', ${overage})`;
  }
}

let result;
if (phase === 'prepare') {
  await migrate(adminUrl);
  const pw = process.env.KATIP_BILLING_DB_PASSWORD;
  if (!/^[\w-]{32,}$/.test(pw ?? '')) throw new Error('KATIP_BILLING_DB_PASSWORD is not set');
  await sql.unsafe(`ALTER ROLE katip_billing PASSWORD '${pw}'`);
  await seedFromUrl(adminUrl); // plans v1, and the demo company with 10 business seats
  const [acme] = await sql`insert into tenants (slug, name, kvkk_addon)
    values ('acme', 'Acme Test Ltd.', true) on conflict (slug) do update set name = excluded.name
    returning id`;
  await sql`insert into seats (tenant_id, plan_code, quantity) values (${acme.id}, 'starter', 5)
    on conflict do nothing`;
  await sql`insert into users (tenant_id, keycloak_id, email, name)
    values (${acme.id}, 'acme-check', 'user@acme.test', 'Test') on conflict do nothing`;
  for (const slug of ['demo', 'acme']) {
    const t = await tenantId(slug);
    await sql`insert into subscriptions (tenant_id, billing_cycle, status, period_start, period_end)
      select ${t}, 'monthly', 'active', now(), now() + interval '1 month'
      where not exists (select 1 from subscriptions where tenant_id = ${t})`;
  }
  // Billing begins at the start of the hour a company is attached: these hours are in it.
  const h = hourAgo(0);
  await usage('demo', [
    [at(h, -170), 'standard', 400_000, 100_000, true],
    [at(h, -150), 'tr', 20_000, 5_000, true],
    [at(h, -140), 'premium', 30_000, 10_000, true],
    [at(h, -130), 'standard', 900_000, 900_000, false],
    [at(h, -110), 'standard', 250_000, 250_000, true],
  ]);
  await usage('acme', [[at(h, -100), 'premium', 1_000, 234, true]]);
  result = { ok: true };
} else if (phase === 'late') {
  await usage('demo', [[at(hourAgo(0), -175), 'standard', 700, 77, true]]);
  result = { added: 777 };
} else if (phase === 'seats') {
  await sql`update seats set quantity = 12 where tenant_id = ${await tenantId('demo')}`;
  result = { seats: 12 };
} else if (phase === 'replay') {
  const u = await sql`update billing_usage_sent set status = 'pending', sent_at = null`;
  const s = await sql`update billing_seat_sent set status = 'pending', sent_at = null`;
  result = { usage: u.count, seats: s.count };
} else if (phase === 'lago') {
  const lago = new LagoClient(process.env.LAGO_API_URL, process.env.LAGO_API_KEY);
  result = {};
  for (const slug of ['demo', 'acme']) {
    const u = await lago.currentUsage(slug, `${slug}-monthly`);
    result[slug] = Object.fromEntries(
      u.charges_usage.map((c) => [c.billable_metric.code, [Number(c.units), c.amount_cents]]),
    );
  }
} else if (phase === 'sent') {
  result = {
    usage: await sql`select t.slug, s.transaction_id, s.tokens, s.status
      from billing_usage_sent s join tenants t on t.id = s.tenant_id order by 2`,
    seats: await sql`select t.slug, s.transaction_id, s.delta, s.status
      from billing_seat_sent s join tenants t on t.id = s.tenant_id order by 2`,
  };
} else {
  throw new Error(`unknown phase: ${phase}`);
}
await sql.end();
console.log(`check-result=${JSON.stringify(result)}`);
