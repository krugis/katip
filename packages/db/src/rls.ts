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

export function tenantRlsSql(table: string): string {
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${table}
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);`;
}

/** Provider endpoints and jobs connect with this role; it bypasses RLS by design. */
export const PROVIDER_ROLE_SQL = `-- provider-admin connects as a separate role with BYPASSRLS
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'katip_provider') THEN
    CREATE ROLE katip_provider NOLOGIN BYPASSRLS;
  END IF;
END $$;
-- audit_log is append-only for app roles (LLD-05 §2): revoke UPDATE/DELETE from PUBLIC.
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;`;
