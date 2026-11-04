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
  'chat_retention_state',
  'chat_retention_notice_recipients',
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
  'billing_usage_sent',
  'billing_seat_sent',
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
GRANT SELECT (tenant_id, user_id), UPDATE (payload) ON requests TO katip_provider;
GRANT SELECT, INSERT ON fx_rates TO katip_provider;
-- The daily job needs each company's chat period, and nothing else about its policy.
GRANT SELECT (tenant_id, chat_retention_months) ON tenant_policies TO katip_provider;
-- It moves a company on when a notice's time is up, and asks for its first notice.
GRANT SELECT, INSERT ON chat_retention_state TO katip_provider;
GRANT UPDATE (in_force_months, notice_id, notice_months, notice_requested_at, notified_at, updated_at) ON chat_retention_state TO katip_provider;
GRANT SELECT (id, tenant_id, user_id, type, status), UPDATE (file_url, status, completed_at) ON privacy_requests TO katip_provider;
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

/**
 * billing-bridge's role (P1-37): bound by RLS, so it works one company at a time, in that
 * company's context. It reads seats and overage token counts, never cost or anything about a
 * request, and it records what it sent. It can't delete, so what was billed stays on record.
 */
export const BILLING_ROLE_SQL = `DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'katip_billing') THEN
    CREATE ROLE katip_billing LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO katip_billing;
GRANT SELECT (id, slug, name, status, kvkk_addon) ON tenants TO katip_billing;
GRANT SELECT ON plans TO katip_billing;
GRANT SELECT (tenant_id, plan_code, quantity) ON seats TO katip_billing;
GRANT SELECT (id, tenant_id, billing_cycle, status, lago_subscription_id) ON subscriptions TO katip_billing;
GRANT UPDATE (lago_subscription_id, updated_at) ON subscriptions TO katip_billing;
GRANT SELECT (tenant_id, ts, class, input_tokens, output_tokens, overage) ON usage_events TO katip_billing;
GRANT SELECT, INSERT ON billing_usage_sent, billing_seat_sent TO katip_billing;
GRANT UPDATE (status, sent_at) ON billing_usage_sent, billing_seat_sent TO katip_billing;`;

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
REVOKE ALL ON FUNCTION refresh_usage_daily(uuid, date, date) FROM PUBLIC;

-- Retention (LLD-10 §8). The periods are here, not passed in, so the role allowed to call
-- this can't delete anything younger, and still has no DELETE of its own.
CREATE OR REPLACE FUNCTION enforce_retention()
RETURNS TABLE (expired_usage bigint, expired_usage_daily bigint, expired_audit bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  WITH u AS (DELETE FROM usage_events WHERE ts < now() - interval '24 months' RETURNING 1),
       d AS (DELETE FROM usage_daily WHERE day < (now() - interval '24 months')::date RETURNING 1),
       a AS (DELETE FROM audit_log WHERE ts < now() - interval '5 years' RETURNING 1)
  SELECT (SELECT count(*) FROM u), (SELECT count(*) FROM d), (SELECT count(*) FROM a);
$fn$;
REVOKE ALL ON FUNCTION enforce_retention() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enforce_retention() TO katip_provider;

-- The daily job's own record belongs to no company, so row-level security hides it from the
-- console. This shows that one thing.
CREATE OR REPLACE FUNCTION latest_daily_run()
RETURNS TABLE (ts timestamptz, details jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT a.ts, a.details FROM audit_log a
  WHERE a.tenant_id IS NULL AND a.action = 'platform.daily'
  ORDER BY a.ts DESC LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION latest_daily_run() FROM PUBLIC;

-- The provider's margin (LLD-06 §6, tracker P1-47): one UTC month's money per company, as sums.
-- The console can't read cost or price itself, and still can't: this hands it totals only, and
-- refuses inside a company's transaction, where every company route runs, so a company's route
-- can't reach it by mistake. Usage comes from usage_events alone, the one table with the price
-- and the overage flag; usage_daily holds cost too, so adding it would count twice.
-- Revenue is list price until the billing bridge (P1-37) records what was invoiced.
CREATE OR REPLACE FUNCTION provider_margin(p_month date)
RETURNS TABLE (tenant_id uuid, slug text, name text, status text, billing_cycle text,
  seats bigint, seat_revenue_usd_micro bigint, addon_revenue_usd_micro bigint,
  overage_revenue_usd_micro bigint, cost_usd_micro bigint, requests bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_start timestamptz := date_trunc('month', p_month::timestamp)::timestamp AT TIME ZONE 'UTC';
  v_end timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month')::timestamp AT TIME ZONE 'UTC';
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'provider_margin is for provider routes only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH used AS (
    -- By the company's id, whoever the person was: file search's nil user counts too.
    SELECT e.tenant_id AS tid,
           coalesce(sum(e.price_usd_micro) FILTER (WHERE e.overage), 0)::bigint AS overage,
           sum(e.cost_usd_micro)::bigint AS cost,
           count(*)::bigint AS requests
    FROM usage_events e
    WHERE e.ts >= v_start AND e.ts < v_end
    GROUP BY e.tenant_id
  ),
  price AS (
    -- Each plan's version in force by the month's end; before any was, the first version.
    SELECT DISTINCT ON (p.code) p.code, p.price_usd_micro AS annual, p.monthly_price_usd_micro AS monthly
    FROM plans p
    ORDER BY p.code, (p.valid_from < v_end) DESC,
      CASE WHEN p.valid_from < v_end THEN p.valid_from END DESC NULLS LAST, p.version
  ),
  cycle AS (
    SELECT DISTINCT ON (s.tenant_id) s.tenant_id AS tid, s.billing_cycle AS cycle
    FROM subscriptions s
    WHERE s.period_start < v_end
    ORDER BY s.tenant_id, s.period_start DESC
  ),
  billed AS (
    -- Seats are owed for a month the company existed in, and wasn't deleted before.
    SELECT t.id AS tid, c.cycle, t.kvkk_addon
    FROM tenants t LEFT JOIN cycle c ON c.tid = t.id
    WHERE t.created_at < v_end
      AND (t.status <> 'deleted'
        OR (SELECT max(a.ts) FROM audit_log a
            WHERE a.tenant_id = t.id AND a.action = 'tenant.delete') >= v_start)
  ),
  seat AS (
    SELECT b.tid, sum(s.quantity)::bigint AS seats,
      coalesce(sum(s.quantity * CASE WHEN b.cycle = 'monthly' THEN pr.monthly ELSE pr.annual END), 0)::bigint AS revenue,
      CASE WHEN bool_or(b.kvkk_addon)
        THEN sum(s.quantity) * coalesce(max(CASE WHEN b.cycle = 'monthly' THEN kv.monthly ELSE kv.annual END), 0)
        ELSE 0 END::bigint AS addon
    FROM billed b
    JOIN seats s ON s.tenant_id = b.tid
    LEFT JOIN price pr ON pr.code = s.plan_code
    LEFT JOIN price kv ON kv.code = 'kvkk_addon'
    GROUP BY b.tid
  ),
  k AS (SELECT b.tid FROM billed b UNION SELECT u.tid FROM used u)
  -- A deleted or purged company keeps its row, and so its slug; an unknown one shows its id.
  SELECT k.tid, coalesce(t.slug, k.tid::text), coalesce(t.name, ''), coalesce(t.status, 'unknown'),
         b.cycle, coalesce(st.seats, 0)::bigint, coalesce(st.revenue, 0)::bigint,
         coalesce(st.addon, 0)::bigint, coalesce(u.overage, 0)::bigint, coalesce(u.cost, 0)::bigint,
         coalesce(u.requests, 0)::bigint
  FROM k
  LEFT JOIN tenants t ON t.id = k.tid
  LEFT JOIN billed b ON b.tid = k.tid
  LEFT JOIN seat st ON st.tid = k.tid
  LEFT JOIN used u ON u.tid = k.tid
  ORDER BY 2;
END
$fn$;
REVOKE ALL ON FUNCTION provider_margin(date) FROM PUBLIC;

-- The month's provider cost by the model that really answered: after a fallback, model_id is
-- the one used, whatever the alias asked for.
CREATE OR REPLACE FUNCTION provider_model_cost(p_month date)
RETURNS TABLE (model_id text, display_name text, class text, requests bigint,
  input_tokens bigint, output_tokens bigint, cost_usd_micro bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
#variable_conflict use_column
DECLARE
  v_start timestamptz := date_trunc('month', p_month::timestamp)::timestamp AT TIME ZONE 'UTC';
  v_end timestamptz := (date_trunc('month', p_month::timestamp) + interval '1 month')::timestamp AT TIME ZONE 'UTC';
BEGIN
  IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'provider_model_cost is for provider routes only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT e.model_id, coalesce(m.display_name, e.model_id), coalesce(m.class, max(e.class)),
         count(*)::bigint, sum(e.input_tokens)::bigint, sum(e.output_tokens)::bigint,
         sum(e.cost_usd_micro)::bigint
  FROM usage_events e LEFT JOIN model_catalog m ON m.id = e.model_id
  WHERE e.ts >= v_start AND e.ts < v_end
  GROUP BY e.model_id, m.display_name, m.class
  ORDER BY 7 DESC, 1;
END
$fn$;
REVOKE ALL ON FUNCTION provider_model_cost(date) FROM PUBLIC;`;

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
GRANT SELECT ON audit_log TO katip_console;
GRANT SELECT, INSERT ON budget_alerts TO katip_console;
GRANT UPDATE (name, budget_usd_micro, policy_override) ON departments TO katip_console;
GRANT DELETE ON department_managers TO katip_console;
GRANT SELECT, INSERT ON requests TO katip_console;
GRANT SELECT, INSERT ON privacy_requests TO katip_console;
GRANT UPDATE (status, completed_at) ON privacy_requests TO katip_console;
GRANT UPDATE (status, decided_by, decided_at) ON requests TO katip_console;
GRANT SELECT (tenant_id, day, user_id, department_id, class, model_id, input_tokens, output_tokens) ON usage_daily TO katip_console;
GRANT EXECUTE ON FUNCTION refresh_usage_daily(uuid, date, date) TO katip_console;
GRANT EXECUTE ON FUNCTION latest_daily_run() TO katip_console;
-- Sums for the provider's margin screen only; console-api calls them from provider routes.
GRANT EXECUTE ON FUNCTION provider_margin(date) TO katip_console;
GRANT EXECUTE ON FUNCTION provider_model_cost(date) TO katip_console;
GRANT SELECT, INSERT, UPDATE ON tenant_policies TO katip_console;
GRANT SELECT, INSERT ON chat_retention_state TO katip_console;
GRANT UPDATE (in_force_months, notice_id, notice_months, notice_requested_at, notified_at, updated_at) ON chat_retention_state TO katip_console;
GRANT SELECT, INSERT ON chat_retention_notice_recipients TO katip_console;
GRANT SELECT, INSERT ON access_rules TO katip_console;
GRANT UPDATE (ip_allowlist, countries, session_idle_min, session_max_h, updated_at) ON access_rules TO katip_console;
GRANT SELECT, INSERT ON policy_history TO katip_console;
-- Without prices: those are our cost.
GRANT SELECT (id, display_name, class, region, data_policy, enabled) ON model_catalog TO katip_console;
GRANT SELECT, INSERT, UPDATE ON jobs TO katip_console;
-- Token counts only: cost is our margin, and prompts' metadata isn't the console's business.
GRANT SELECT (tenant_id, ts, class, source, input_tokens, output_tokens) ON usage_events TO katip_console;
GRANT UPDATE (name, role, department_id, seat_plan_code, status, updated_at) ON users TO katip_console;`;
