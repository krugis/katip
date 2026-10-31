# LLD-04 — Governance console and user portal

One React app (`apps/console`) serves four role-based areas. Its backend is `apps/console-api` (Fastify, REST `/api/v1`, OpenAPI from Zod).

## 1. Areas and screens

### 1.1 Provider admin (us)

| Screen | Functions |
| --- | --- |
| Tenants | List/search; create (calls the provisioner); suspend/resume; plan and seats; KVKK flag; health of the tenant instance |
| Plans and prices | Edit plan quotas and prices (versioned; applies at the next billing period) |
| Model catalog | Enable/disable models, class (standard/premium/tr), prices, region, data policy, provider |
| Router rules | Edit global routing rules (§4 of LLD-03); dry-run a sample request |
| Platform usage and margin | Cost (provider) vs revenue per tenant and model; top tenants; anomalies |
| Audit | Global audit search |
| Operations | Links to Grafana and Lago (Tailscale only); release version per tenant |

### 1.2 Tenant admin (customer IT)

| Screen | Functions |
| --- | --- |
| Overview | Seats used, quota consumption (std/premium/research) vs pooled limit, month-to-date cost, alerts |
| Users | Invite (email), bulk CSV import, assign tier (Starter/Business/Studio seat), department, role; disable; reset MFA |
| Departments | Create, assign managers, department budget (USD/month) and policy overrides |
| Models and policies | Allowed aliases and models; behaviour at 100% (`block`/`downgrade`/`overage`); PII mode and per-entity overrides; data residency (KVKK add-on) |
| Access rules | IP allowlist, allowed countries, MFA required, session idle/max, (phase 2) trusted devices |
| Identity | Connect Entra ID or Google Workspace (guided form → Keycloak IdP link); domain verification (DNS TXT) |
| Usage and reports | By user, department, model, day; CSV export; monthly PDF summary |
| Billing | Plan, seats, invoices (from Lago), payment method link, overage settings |
| Audit | Tenant-scoped audit log |
| Agents and flows approval | Phase 2: approve agents and Studio flows for company-wide publishing |

### 1.3 Department manager

Overview, department users, department budget alerts, approval requests (model access, budget increase), department usage.

### 1.4 User portal ("My account")

Linked from LibreChat via the menu link / custom footer (verify LibreChat `interface` config options).

| Screen | Functions |
| --- | --- |
| My usage | This month's tokens and cost-equivalent, remaining personal share of the pool (if a user cap is set), deep-research runs left |
| Requests | Ask for premium access, a higher budget or a new model → routed to the dept manager or tenant admin |
| Devices and sessions | Active sessions (Keycloak account API), sign out others, manage passkeys/OTP (link to the Keycloak account console) |
| API keys | Phase 2: personal API keys with scopes and expiry |
| Privacy (KVKK) | Download my data (export job: LibreChat conversations via Mongo + usage); request deletion (creates a ticket for the tenant admin; executed by the provisioner job) |
| Preferences | Default alias (`auto`/`fast`/`best`), language |

## 2. API (excerpt; full OpenAPI generated)

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/me` | any | User, tenant, roles, seat, quotas |
| GET | `/api/v1/me/usage?month=2026-11` | any | |
| POST | `/api/v1/me/requests` | any | `{type: premium_access/budget/model, reason}` |
| POST | `/api/v1/me/privacy/export` | any | Async job; returns job id |
| GET/POST/PATCH | `/api/v1/tenants/:tid/users` | tenant_admin | Invite, change tier/department/role, disable |
| POST | `/api/v1/tenants/:tid/users:import` | tenant_admin | CSV (email, name, department, tier) |
| GET/PUT | `/api/v1/tenants/:tid/policy` | tenant_admin | Effective policy JSON (zod `TenantPolicy`) |
| GET/PUT | `/api/v1/tenants/:tid/access-rules` | tenant_admin | Validates lock-out (§LLD-02 6) |
| GET/POST/PATCH | `/api/v1/tenants/:tid/departments` | tenant_admin | |
| GET | `/api/v1/tenants/:tid/usage?groupBy=user|dept|model|day&from&to` | tenant_admin, dept_manager (own dept) | From `usage_daily` |
| GET | `/api/v1/tenants/:tid/audit?…` | tenant_admin | |
| POST | `/api/v1/admin/tenants` | provider_admin | Calls the provisioner |
| PUT | `/api/v1/admin/models/:id`, `/api/v1/admin/router-rules` | provider_admin | Publishes `policy.changed` |

Every mutation:

- validates with Zod;
- checks role + scope;
- runs inside a transaction with `SET LOCAL app.tenant_id`;
- writes `audit_log`;
- publishes a Valkey event for gateway cache invalidation.

## 3. Policy document (`TenantPolicy`, stored as JSONB, validated by Zod)

```ts
type TenantPolicy = {
  aliases: { auto: boolean; fast: boolean; best: boolean; trLocal: boolean };
  allowUserModelChoice: boolean;
  allowedModels: string[];               // model_catalog ids, subset of global
  atQuotaLimit: 'block' | 'downgrade' | 'overage';
  overageCapUsd?: number;                // monthly cap when overage
  pii: { mode: 'off' | 'mask' | 'block'; entities: Record<string, 'off' | 'mask' | 'block'> };
  residency: 'ANY_APPROVED' | 'EU_ONLY' | 'TR_ONLY';
  userMonthlyCapUsd?: number;            // optional per-user cap inside the pool
  storePrompts: false;                    // phase 1: always false
};
// Department overrides: Partial<TenantPolicy> minus residency loosening (a dept may only be stricter)
```

## 4. UI notes

- **Languages.** Turkish first, English second. Use i18next; all strings in `apps/console/src/locales/{tr,en}.json`.
- **Accessibility.** Use shadcn components and keyboard navigation.
- **Charts.** Recharts: usage over time, split by class.
- **Empty states.** Every list explains the next action ("Invite your first user").

## 5. Acceptance criteria

- A tenant admin can invite 3 users, assign tiers and departments, and those users can log in to LibreChat within 2 minutes.
- A dept manager sees only their department's usage. A direct API call for another department returns 404.
- A user sees their usage update within 1 minute of a chat.
- Changing the policy to `atQuotaLimit: downgrade` takes effect in the gateway within 30 seconds (cache invalidation).
- All console API endpoints have an RBAC test matrix (role × endpoint × own/other tenant).
