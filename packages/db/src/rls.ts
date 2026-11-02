// SPDX-License-Identifier: AGPL-3.0-only
// Row-level security (LLD-05 §1): every tenant-owned table filters on app.tenant_id.
// The provider-admin role uses a separate DB role with BYPASSRLS, used only by
// provider endpoints and jobs.

/** Tables that carry tenant_id and get RLS. audit_log.tenant_id is nullable. */
export const TENANT_OWNED_TABLES = [
  'subscriptions',
  'seats',
  'departments',
  'department_managers',
  'users',
  'gateway_keys',
  'tenant_policies',
  'policy_history',
  'access_rules',
  'tenant_model_allow',
  'usage_events',
  'usage_daily',
  'tenant_limits',
  'budget_alerts',
  'requests',
  'audit_log',
  'jobs',
  'privacy_requests',
  'invoices',
] as const;

/**
 * No tenant context means no rows, rather than an error. NULLIF because a setting made
 * with SET LOCAL reads as '' once its transaction ends, on a pooled connection.
 */
const TENANT_CONTEXT = `NULLIF(current_setting('app.tenant_id', true), '')::uuid`;

export function tenantRlsSql(table: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = ${TENANT_CONTEXT})
  WITH CHECK (tenant_id = ${TENANT_CONTEXT});`;
}

/** Provider endpoints and jobs connect with this role; it bypasses RLS by design. */
export const PROVIDER_ROLE_SQL = `-- provider-admin connects as a separate role with BYPASSRLS
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'katip_provider') THEN
    CREATE ROLE katip_provider LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE katip_provider LOGIN;
GRANT USAGE ON SCHEMA public TO katip_provider;
GRANT SELECT ON plans, tenants, users, gateway_keys TO katip_provider;
GRANT INSERT ON tenants, subscriptions, seats, tenant_policies, access_rules, tenant_limits, users, gateway_keys, audit_log TO katip_provider;
GRANT UPDATE (revoked_at) ON gateway_keys TO katip_provider;
GRANT UPDATE (status) ON tenants TO katip_provider;
GRANT UPDATE (email, name, keycloak_id, status) ON users TO katip_provider;
GRANT SELECT (tenant_id), UPDATE (payload) ON requests TO katip_provider;
GRANT SELECT (tenant_id), UPDATE (file_url) ON privacy_requests TO katip_provider;
GRANT SELECT, INSERT, UPDATE ON jobs TO katip_provider;
-- audit_log is append-only for app roles (LLD-05 §2): revoke UPDATE/DELETE from PUBLIC.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;`;

/** Tables the gateway may read. Tenant-owned ones among them are still limited by RLS. */
const GATEWAY_READS = [
  'tenants',
  'gateway_keys',
  'users',
  'departments',
  'tenant_policies',
  'tenant_limits',
  'model_catalog',
  'router_rules',
];

/**
 * The gateway's own role: not a superuser and bound by RLS, so a query that misses a
 * tenant filter still can't cross tenants. It looks up keys before it knows the tenant,
 * so gateway_keys alone is readable without a tenant context; a key hash can't be used
 * to log in. Its password is set by whoever deploys it.
 */
export const GATEWAY_ROLE_SQL = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'katip_gateway') THEN
    CREATE ROLE katip_gateway LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO katip_gateway;
GRANT SELECT ON ${GATEWAY_READS.join(', ')} TO katip_gateway;
GRANT INSERT ON usage_events TO katip_gateway;
DROP POLICY IF EXISTS gateway_key_lookup ON gateway_keys;
CREATE POLICY gateway_key_lookup ON gateway_keys FOR SELECT TO katip_gateway USING (true);`;

/** Tables the console API may read so far. Each new endpoint adds only what it needs. */
const CONSOLE_READS = [
  'tenants',
  'users',
  'seats',
  'departments',
  'department_managers',
  'tenant_limits',
];

/**
 * Rolls usage_events up into usage_daily, cost included. It runs with its owner's rights, so
 * the console can ask for a roll-up without being able to read cost itself. Run for a whole
 * range each time, so the totals always match the events.
 */
export const USAGE_ROLLUP_SQL = `CREATE OR REPLACE FUNCTION refresh_usage_daily(p_tenant uuid, p_from date, p_to date)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  DELETE FROM usage_daily WHERE tenant_id = p_tenant AND day BETWEEN p_from AND p_to;
  INSERT INTO usage_daily
    (tenant_id, day, user_id, department_id, class, model_id, input_tokens, output_tokens, cost_usd_micro)
  SELECT tenant_id, (ts AT TIME ZONE 'UTC')::date, user_id,
         (array_agg(department_id ORDER BY ts DESC))[1], class, model_id,
         sum(input_tokens), sum(output_tokens), sum(cost_usd_micro)
  FROM usage_events
  WHERE tenant_id = p_tenant
    AND ts >= p_from::timestamp AT TIME ZONE 'UTC'
    AND ts < (p_to + 1)::timestamp AT TIME ZONE 'UTC'
  GROUP BY tenant_id, (ts AT TIME ZONE 'UTC')::date, user_id, class, model_id;
$fn$;
REVOKE ALL ON FUNCTION refresh_usage_daily(uuid, date, date) FROM PUBLIC;`;

/** The console API's own role: not a superuser and bound by RLS, with no lookup exception. */
export const CONSOLE_ROLE_SQL = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'katip_console') THEN
    CREATE ROLE katip_console LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO katip_console;
GRANT SELECT ON ${CONSOLE_READS.join(', ')} TO katip_console;
GRANT INSERT ON users, audit_log, departments, department_managers TO katip_console;
GRANT UPDATE (name, budget_usd_micro) ON departments TO katip_console;
GRANT DELETE ON department_managers TO katip_console;
GRANT SELECT ON requests TO katip_console;
GRANT UPDATE (status, decided_by, decided_at) ON requests TO katip_console;
GRANT SELECT (tenant_id, day, user_id, department_id, class, model_id, input_tokens, output_tokens) ON usage_daily TO katip_console;
GRANT EXECUTE ON FUNCTION refresh_usage_daily(uuid, date, date) TO katip_console;
GRANT SELECT, INSERT, UPDATE ON tenant_policies TO katip_console;
GRANT SELECT, INSERT ON access_rules TO katip_console;
GRANT UPDATE (ip_allowlist, countries, session_idle_min, session_max_h, updated_at) ON access_rules TO katip_console;
GRANT SELECT, INSERT ON policy_history TO katip_console;
-- Without prices: those are our cost.
GRANT SELECT (id, display_name, class, region, data_policy, enabled) ON model_catalog TO katip_console;
GRANT SELECT, INSERT, UPDATE ON jobs TO katip_console;
-- Token counts only: cost is our margin, and prompts' metadata isn't the console's business.
GRANT SELECT (tenant_id, ts, class, source, input_tokens, output_tokens) ON usage_events TO katip_console;
GRANT UPDATE (name, role, department_id, seat_plan_code, status, updated_at) ON users TO katip_console;`;
