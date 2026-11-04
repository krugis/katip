// SPDX-License-Identifier: AGPL-3.0-only
import type postgres from 'postgres';

/**
 * Removes the rows of a tenant whose first creation failed, as the admin role: the
 * provisioner's own role can't delete anything (LLD-05 §1). A tenant with users has been in
 * use, so this refuses it. Foreign keys refuse anything else that refers to the tenant.
 * Its failed jobs stay, without the link, as the record of what happened.
 */
export async function forgetUnfinishedTenant(sql: postgres.Sql, slug: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [tenant] = await tx<{ id: string }[]>`select id from tenants where slug = ${slug}`;
    if (!tenant) return;
    const id = tenant.id;
    const users = await tx`select 1 from users where tenant_id = ${id} limit 1`;
    if (users.length > 0) throw new Error(`tenant ${slug} has users, so it will not be removed`);
    await tx`update jobs set tenant_id = null where tenant_id = ${id}`;
    await tx`delete from gateway_keys where tenant_id = ${id}`;
    await tx`delete from tenant_limits where tenant_id = ${id}`;
    await tx`delete from access_rules where tenant_id = ${id}`;
    await tx`delete from chat_retention_state where tenant_id = ${id}`;
    await tx`delete from tenant_policies where tenant_id = ${id}`;
    await tx`delete from billing_seat_sent where tenant_id = ${id}`;
    await tx`delete from billing_usage_sent where tenant_id = ${id}`;
    await tx`delete from seats where tenant_id = ${id}`;
    await tx`delete from subscriptions where tenant_id = ${id}`;
    await tx`delete from tenants where id = ${id}`;
  });
}
