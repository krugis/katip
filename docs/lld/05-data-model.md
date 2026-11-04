# LLD-05 — Governance data model (PostgreSQL)

The `governance` database is owned by `packages/db` (Drizzle). LibreChat data stays in MongoDB (one database per tenant) and is not modelled here.

## 1. Conventions

- PK `id uuid` (v7). Every tenant-owned table has `tenant_id uuid not null` plus an index.
- `created_at`, `updated_at timestamptz default now()`.
- **Row-level security** on every tenant-owned table:

  ```sql
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  ```

  No tenant context means no rows, rather than an error. `NULLIF` is there because a setting made with `SET LOCAL` reads as `''` once its transaction ends, on a pooled connection.
- **Database roles.** RLS only works for a role that doesn't bypass it, so each role is deliberate:

  | Role | Used by | RLS | Notes |
  | --- | --- | --- | --- |
  | `katip` | Migrations and seeds only | Bypassed (superuser) | Never used by a running service |
  | `katip_gateway` | Policy gateway | **Applies** | `SELECT` on what it reads, `INSERT` on `usage_events`. Runs each tenant query in a transaction with `set_config('app.tenant_id', …, true)`. `gateway_keys` alone is readable with no tenant context, because a key lookup is how the tenant is found |
  | `katip_console` | Console API | **Applies** | `SELECT` on `tenants` and `users` so far; each new endpoint adds only what it needs. No exception for lookups: `tenants` has no RLS, and the tenant comes from the verified token |
  | `katip_provider` | Provisioner; later, provider endpoints and jobs | Bypassed by design (`BYPASSRLS`): a tenant being created has no context yet | Not a superuser. Can add tenants, change their status, anonymise users on a purge, and read what it needs. Can't read usage, invoices or request contents, change plans or the catalog, or delete tenants or users |
  | `katip_billing` | billing-bridge (LLD-06 §2.2) | **Applies** | Works one company at a time in its context. `SELECT` on `plans`, some columns of `tenants`, `seats` and `subscriptions`, and only `tenant_id, ts, class, input_tokens, output_tokens, overage` of `usage_events` (never cost). `UPDATE (lago_subscription_id)` on `subscriptions`. `SELECT, INSERT` and `UPDATE (status, sent_at)` on `billing_usage_sent` and `billing_seat_sent`. No `DELETE` anywhere |

  Tests of tenant isolation must connect as the role the service uses, as an admin role passes them regardless.
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
| `tenant_policies` | tenant_id (PK), policy jsonb (`TenantPolicy`), version, chat_retention_months (1 to 120, default 12), updated_by | History of `policy` in `policy_history`. `katip_provider` can read only tenant_id and chat_retention_months |
| `chat_retention_state` | tenant_id (PK), in_force_months, notice_id, notice_months, notice_requested_at, notified_at, updated_at | Where a company stands on deleting old chats (LLD-07 §2c). No row means nothing has happened yet. `console-api` and `katip_provider` can read and write it, but not delete it or change its tenant_id |
| `chat_retention_notice_recipients` | notice_id + user_id (PK), tenant_id, sent_at | Who has been told of a notice, so each person is told once. `console-api` only, and it can't delete from it |
| `access_rules` | tenant_id (PK), ip_allowlist cidr[], countries char(2)[], mfa_required, session_idle_min, session_max_h, device_trust | |
| `model_catalog` | id, litellm_name, display_name, class (`standard/premium/tr/embedding`), provider, region, data_policy (`zero_retention/30d/unknown`), price_in_usd_micro_per_m, price_out_usd_micro_per_m, enabled, self_hosted (false unless the config marks it, LLD-03 §5) | Global |
| `tenant_model_allow` | tenant_id, model_id | |
| `router_rules` | id, scope (`global/tenant`), tenant_id null, priority, condition jsonb, route jsonb, enabled | |
| `usage_events` | id, tenant_id, user_id, department_id, ts, alias, model_id, class, input_tokens, cached_tokens, output_tokens, cost_usd_micro (provider cost), price_usd_micro (our list price for overage), conversation_id, source (`chat/embedding/research/flow`), flow_run_id, fallback bool, overage bool, request_id, tool_calls | **Partitioned by month** (`ts`); retained 24 months |
| `usage_daily` | tenant_id, day, user_id, department_id, class, model_id, sums… | Rolled up by `refresh_usage_daily()`, which runs with its owner's rights, so `console-api` can ask for a roll-up without being able to read cost. It replaces the range asked for, so it always matches the events. A person has one department per day: someone who moves that day is counted under the one they ended it in |
| `tenant_limits` | tenant_id, month, std_tokens, prem_tokens, research_runs (computed from seats + packs) | Cache of entitlements |
| `budget_alerts` | tenant_id, scope, scope_id, month, threshold (50/80/100), sent_at | Prevents duplicate alerts |
| `requests` | tenant_id, user_id, type, payload jsonb, status, decided_by, decided_at | Portal requests |
| `audit_log` | id, tenant_id null, actor_type (`user/provider/system`), actor_id, action, target_type, target_id, ip, details jsonb, ts | Append-only: revoke UPDATE/DELETE; monthly partitions; 5 years |
| `jobs` | id, type, tenant_id, status, payload, result, attempts | Mirrors BullMQ for visibility |
| `privacy_requests` | tenant_id, user_id, type (`export/delete`), status, file_url, completed_at | KVKK |
| `fx_rates` | rate_date, currency, buying, selling, created_at | The central bank's rates. Not tenant data. The provisioner's role can add one but not change one |
| `invoices` | tenant_id, lago_invoice_id, number, total_usd_micro, total_try_kurus, fx_rate, efatura_status, efatura_uuid, issued_at | LLD-06 |
| `billing_usage_sent` | tenant_id + hour + class + seq (PK), tokens, transaction_id (unique), lago_subscription_id, event_ts, status (`pending/sent`), created_at, sent_at | Overage events sent to Lago (LLD-06 §2.2). seq 0 is an hour's first event; late usage adds the next seq, for the difference. Σ tokens of an hour = what Lago has for it. Written before the event goes, so a run can resume |
| `billing_seat_sent` | tenant_id + metric + seq (PK), delta, units_after, transaction_id (unique), lago_subscription_id, event_ts, status, created_at, sent_at | Seat changes sent to Lago, each as the difference from the last |

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
