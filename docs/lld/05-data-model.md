# LLD-05 — Governance data model (PostgreSQL)

The `governance` database is owned by `packages/db` (Drizzle). LibreChat data stays in MongoDB (one database per tenant) and is not modelled here.

## 1. Conventions

- PK `id uuid` (v7). Every tenant-owned table has `tenant_id uuid not null` plus an index.
- `created_at`, `updated_at timestamptz default now()`.
- **Row-level security** on every tenant-owned table:

  ```sql
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  ```

  The provider-admin role uses a separate DB role with `BYPASSRLS`, used only by provider endpoints and jobs.
- Money is stored as `bigint` micro-USD; tokens as `bigint`.

## 2. Tables

| Table | Key columns | Notes |
| --- | --- | --- |
| `tenants` | id, slug (unique), name, status (`active/suspended/deleted`), region (`eu/tr`), kvkk_addon bool, custom_domain, created_at | |
| `plans` | code (`starter/business/studio/community`), version, price_usd_micro, monthly_price_usd_micro, std_tokens, prem_tokens, research_runs, files_gb, features jsonb, valid_from | Versioned; never update in place |
| `subscriptions` | tenant_id, billing_cycle (`annual/monthly`), status, period_start, period_end, lago_subscription_id | |
| `seats` | tenant_id, plan_code, quantity | Purchased seats per plan |
| `departments` | tenant_id, name, budget_usd_micro, policy_override jsonb | |
| `department_managers` | department_id, user_id | |
| `users` | tenant_id, keycloak_id (unique), email (unique per tenant, citext), name, department_id, role, seat_plan_code, status, user_cap_usd_micro, created_at, last_seen_at | Mirrors Keycloak; seat assignment lives here |
| `gateway_keys` | tenant_id, key_hash (argon2id), prefix, type (`tenant/user/service`), user_id null, scopes text[], expires_at, revoked_at | |
| `tenant_policies` | tenant_id (PK), policy jsonb (`TenantPolicy`), version, updated_by | History in `policy_history` |
| `access_rules` | tenant_id (PK), ip_allowlist cidr[], countries char(2)[], mfa_required, session_idle_min, session_max_h, device_trust | |
| `model_catalog` | id, litellm_name, display_name, class (`standard/premium/tr/embedding`), provider, region, data_policy (`zero_retention/30d/unknown`), price_in_usd_micro_per_m, price_out_usd_micro_per_m, enabled | Global |
| `tenant_model_allow` | tenant_id, model_id | |
| `router_rules` | id, scope (`global/tenant`), tenant_id null, priority, condition jsonb, route jsonb, enabled | |
| `usage_events` | id, tenant_id, user_id, department_id, ts, alias, model_id, class, input_tokens, cached_tokens, output_tokens, cost_usd_micro (provider cost), price_usd_micro (our list price for overage), conversation_id, source (`chat/embedding/research/flow`), flow_run_id, fallback bool, overage bool, request_id | **Partitioned by month** (`ts`); retained 24 months |
| `usage_daily` | tenant_id, day, user_id, department_id, class, model_id, sums… | Materialised by a nightly job and incremental upsert |
| `tenant_limits` | tenant_id, month, std_tokens, prem_tokens, research_runs (computed from seats + packs) | Cache of entitlements |
| `budget_alerts` | tenant_id, scope, scope_id, month, threshold (50/80/100), sent_at | Prevents duplicate alerts |
| `requests` | tenant_id, user_id, type, payload jsonb, status, decided_by, decided_at | Portal requests |
| `audit_log` | id, tenant_id null, actor_type (`user/provider/system`), actor_id, action, target_type, target_id, ip, details jsonb, ts | Append-only: revoke UPDATE/DELETE; monthly partitions; 5 years |
| `jobs` | id, type, tenant_id, status, payload, result, attempts | Mirrors BullMQ for visibility |
| `privacy_requests` | tenant_id, user_id, type (`export/delete`), status, file_url, completed_at | KVKK |
| `invoices` | tenant_id, lago_invoice_id, number, total_usd_micro, total_try_kurus, fx_rate, efatura_status, efatura_uuid, issued_at | LLD-06 |

## 3. Indexes (minimum)

- `usage_events (tenant_id, ts)`, `(tenant_id, user_id, ts)`, `(tenant_id, department_id, ts)`
- `users (tenant_id, email)` unique; `users (keycloak_id)` unique
- `audit_log (tenant_id, ts desc)`

## 4. Seed data

- `plans` v1 per DESIGN §5.
- `model_catalog` with the models in LLD-03 §3, using prices from `llm-cost-comparison-openrouter.xlsx` (prices per 1M tokens converted to micro-USD).
- `router_rules` v1 from LLD-03 §4.
- A `demo` tenant with 3 users (admin, manager, user) for local dev.

## 5. Acceptance criteria

- The RLS test suite proves a session with `app.tenant_id = A` cannot read or write rows of tenant B in any tenant-owned table.
- Migrations run forward from empty and are idempotent in CI. A rollback script exists for each release.
- Partition creation for the next 3 months is automated (pg_cron or the app job), with an alert if missing.
