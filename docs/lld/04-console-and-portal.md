# LLD-04 — Governance console and user portal

One React app (`apps/console`) serves four role-based areas. Its backend is `apps/console-api` (Fastify, REST `/api/v1`, OpenAPI from Zod).

**Built so far (P1-25):** the shell. Sign-in with Keycloak (PKCE), Turkish first and English, navigation by role, and a no-access page. Real so far: the provider's company list, and the tenant admin's overview, users, departments (P1-26) models and policies (P1-27), access rules (P1-28), usage and reports (P1-30), the department manager's area (P1-31), each person's account (P1-32), and the audit log (P1-33). Every other screen says it's on its way, until its own task arrives. The app only reflects access: `console-api` enforces it. `pnpm test:console` checks each role in a real browser.

**How it's served.** Static files from an unprivileged nginx at `console.<domain>`, with `/api` going to `console-api` by a longer Traefik rule, so both share an origin. nginx fills `/config.json` from the environment, so one image serves any domain. It sends a strict content security policy: no inline scripts or styles, and only Keycloak as another origin to call.

**Tokens** stay in `sessionStorage`, so they go with the tab. They renew by refresh token rather than a hidden iframe, which that policy forbids.

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
| Models and policies | Allowed aliases and models; behaviour at 100% (`block`/`downgrade`/`overage`); PII mode and per-entity overrides; data residency (KVKK add-on), with a warning when a rule leaves file search with no embedding model |
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
| Privacy (KVKK) | Download my data (export job: LibreChat conversations via Mongo + usage); request deletion (the tenant admin approves it, and the provisioner job carries it out: LLD-07 §2b) |
| Preferences | Default alias (`auto`/`fast`/`best`), language |

## 2. API (excerpt; full OpenAPI generated)

**Built so far (P1-20):** token check, role and tenant checks, problem+json errors, OpenAPI at `/api/v1/openapi.json`, `GET /api/v1/me`, `GET /api/v1/tenants/:tid` and `GET /api/v1/admin/tenants`. The rest of this table arrives with its own tasks.

- **Deny by default:** the server won't start if an `/api/v1` route doesn't declare who may use it.
- **Status codes:** no or bad token 401; wrong role 403; another tenant's resource 404, so a caller can't tell it exists.
- **Test matrix:** `apps/console-api/test/rbac.test.ts` holds role × endpoint × own or other tenant, and fails if an API route is missing from it.
- **Every request reads the user:** a disabled user or suspended company is refused immediately, whatever the token says.

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| GET | `/api/v1/me` | any | User, tenant, roles, seat, quotas |
| GET | `/api/v1/me/usage?groupBy=model\|day&from&to` | any | The caller's own tokens, up to date at once |
| GET/POST | `/api/v1/me/requests` | any | `{type: premium_access/budget/model, reason}`. Up to 10 waiting per person |
| GET/PATCH | `/api/v1/tenants/:tid/requests`, `/requests/:rid`, `/privacy-requests/:pid` | tenant_admin | Everyone's requests, including people with no department, and privacy requests |
| GET | `/api/v1/me/privacy` | any | The caller's own privacy requests |
| POST | `/api/v1/me/privacy/export` | any | What the governance database holds about the caller. **Not chats**, which LibreChat holds: the file says where they are (P1-68). Recorded and audited |
| POST | `/api/v1/me/privacy/delete` | any | Creates a request for the company admin, once. Deletes nothing itself |
| GET/POST/PATCH | `/api/v1/tenants/:tid/users` | tenant_admin | Invite, change tier/department/role, disable |
| POST | `/api/v1/tenants/:tid/users/:uid/invite` | tenant_admin | Send the invite again |
| POST | `/api/v1/tenants/:tid/users/import` | tenant_admin | CSV (email, name, department, tier); comma or semicolon. Up to 1000 rows. Runs in the background and answers 202 with a job id |
| GET | `/api/v1/tenants/:tid/users/imports/:jid` | tenant_admin | Progress, with failed rows by number and reason. The job holds no addresses |
| GET | `/api/v1/tenants/:tid/overview` | tenant_admin | Seats, and this month's tokens against the pooled limit. Never cost: that's our margin, and the console's role can't read it |
| GET/PUT | `/api/v1/tenants/:tid/policy` | tenant_admin | The company's policy (zod `PolicySchema`), and the catalog without prices. PUT needs the version it read, and refuses a stale one. Residency and `tr-local` need the KVKK add-on. Publishes `policy.changed`; if that fails, the gateway's cache expires within 30 s anyway |
| GET/PUT | `/api/v1/tenants/:tid/departments/:did/policy` | tenant_admin | A department's rules, which can only be stricter than the company's. The API refuses anything looser, and the gateway enforces it again on every request, so a company tightening later can't leave a department looser than itself |
| GET/PUT | `/api/v1/tenants/:tid/chat-retention` | tenant_admin | How long the company keeps chats, in whole months from 1 to 120. Separate from the policy document, so it has no version and doesn't announce `policy.changed`. Audited as `chat_retention.update` with both values |
| GET/PUT | `/api/v1/tenants/:tid/access-rules` | tenant_admin | Refuses a list that leaves out the caller's address unless `force` is set (LLD-02 §6) |
| GET/POST/PATCH | `/api/v1/tenants/:tid/departments` | tenant_admin | |
| GET | `/api/v1/tenants/:tid/usage?groupBy=user\|dept\|model\|day&from&to` | tenant_admin | Tokens from `usage_daily`, rolled up from the events on each request, so the numbers always match them. UTC days, up to 400. Never cost |
| GET | `/api/v1/tenants/:tid/usage/export?…` | tenant_admin | The same as CSV, with a byte order mark and semicolons for Excel in Turkish, and cells that can't run as formulas |
| GET | `/api/v1/tenants/:tid/my-departments` | tenant_admin, dept_manager | Those they manage; all for an admin |
| GET | `/api/v1/tenants/:tid/departments/:did/users`, `/usage`, `/usage/export`, `/requests` | tenant_admin, dept_manager of that department | Any other department answers 404 |
| PATCH | `/api/v1/tenants/:tid/departments/:did/requests/:rid` | tenant_admin, dept_manager of that department | Approve or decline, once. Nobody decides their own. It records the decision, and doesn't change access yet |
| GET | `/api/v1/tenants/:tid/audit?action&before&limit` | tenant_admin | Newest first, a page at a time. Names a person only if they're in this company |
| GET | `/api/v1/admin/audit?tenant&action&before&limit` | provider_admin | Every company's log, one company at a time under row-level security |
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
- **Accessibility.** shadcn-style components, keyboard navigation, landmarks and a skip link.
- **Charts.** Recharts: usage over time, split by class.
- **Empty states.** Every list explains the next action ("Invite your first user").

## 5. Acceptance criteria

- A tenant admin can invite 3 users, assign tiers and departments, and those users can log in to LibreChat within 2 minutes.
- A dept manager sees only their department's usage. A direct API call for another department returns 404.
- A user sees their usage update within 1 minute of a chat.
- Changing the policy to `atQuotaLimit: downgrade` takes effect in the gateway within 30 seconds (cache invalidation).
- All console API endpoints have an RBAC test matrix (role × endpoint × own/other tenant).
