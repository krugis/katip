# LLD-02 — Identity, tenancy and access rules

## 1. Keycloak layout

| Item | Value |
| --- | --- |
| Realm | `identity.realm` in `katip.config.yaml`, default `katip` (single realm) |
| Organizations | one per tenant (`alias = tenant slug`), plus `provider` for our staff |
| Clients | `console` (public, PKCE; its tokens carry audience `console-api`); `lc-<slug>` per tenant LibreChat instance (confidential); `katip-provisioner` (service account, with `realm-admin` on this realm only) |
| Realm roles | `provider_admin`, `tenant_admin`, `dept_manager`, `user` |
| Client roles (per `lc-<slug>`) | `member`: required to log in to that tenant's LibreChat |
| Identity providers | Per tenant (optional): the customer's Entra ID (OIDC) or Google Workspace, linked to the tenant organization (Keycloak 26 organizations support IdP linking; verify behaviour for the pinned version) |
| MFA | Browser flow copy `<realm>-browser`: passkeys enabled; local accounts must enrol OTP at first login (default required action `CONFIGURE_TOTP`) and can add a passkey afterwards, because Keycloak's built-in steps can't offer a choice at enrolment; a user with either credential is asked for it at login; skipped when the user logs in via a linked customer IdP (their MFA applies; not built yet) |
| Themes | `katip` login theme (`infra/keycloak/themes`), Turkish + English |
| Tokens | Access token 5 min, SSO session idle 30 min (tenant-configurable 15–480), max 10 h |

### 1.1 Token claims (protocol mappers)

| Claim | Source | Used by |
| --- | --- | --- |
| `sub`, `email`, `name` | built-in | LibreChat, console |
| `organization` | organization scope, which the login must request (`scope=openid organization`): Keycloak leaves it out otherwise, even as a default scope | console-api: **this is the tenant**, looked up by alias. Exactly one customer organization is required, so a token without it is refused |
| `department_id` | user attribute | console-api |
| `realm_access.roles` | built-in | console RBAC |
| `resource_access.lc-<slug>.roles` | built-in | LibreChat login gate |

### 1.2 Who holds Keycloak's admin rights

`console-api` faces the internet and holds none. Tested on Keycloak 26.8: adding a user to an organization needs `manage-realm`, which can also change realm settings such as the login flow and MFA, and `manage-users` can reset any password, including a provider admin's. So the rights sit in the internal **identity service** (`apps/provisioner/src/identity-server.ts`), on the backend network only, never behind Traefik, and reached with a token only console-api has. It offers fixed actions: invite, send invite, set role, enable or disable. It refuses the provider organization, the `provider_admin` role, and anyone not in that one company. A hacked console-api could still act on tenants' users, but couldn't change login rules, reach provider admins or grant `provider_admin`. The owner chose this on 2 Nov 2026.

## 2. LibreChat OIDC configuration (per tenant)

```env
ALLOW_EMAIL_LOGIN=false
ALLOW_REGISTRATION=false
ALLOW_SOCIAL_LOGIN=true
OPENID_ISSUER=https://auth.<domain>/realms/katip
OPENID_CLIENT_ID=lc-<slug>
OPENID_CLIENT_SECRET=<from provisioner>
OPENID_SESSION_SECRET=<random 32 bytes>
OPENID_SCOPE="openid profile email"
OPENID_CALLBACK_URL=/oauth/openid/callback
OPENID_REQUIRED_ROLE=member
OPENID_REQUIRED_ROLE_TOKEN_KIND=access
OPENID_REQUIRED_ROLE_PARAMETER_PATH=resource_access.lc-<slug>.roles
OPENID_USE_END_SESSION_ENDPOINT=true
OPENID_BUTTON_LABEL="Giriş yap / Sign in"
```

These variables and the client-role path are verified on LibreChat v0.7.8 by the bootstrap's login smoke test. The path is split on dots, so slugs (which can't contain dots) are safe. `dev:up` applies all of this from `katip.config.yaml` through the Admin API (`scripts/setup/keycloak.mjs`).

**Fallback.** If client-role paths with dashes or dots do not work, use the realm role `member-<slug>` with `realm_access.roles`.

## 3. Tenant and user lifecycle (identity part)

| Event | Action (provisioner / console-api) |
| --- | --- |
| Tenant created | Create organization `<slug>`; create client `lc-<slug>` (redirect `https://<slug>.<domain>/oauth/openid/callback`); create client role `member`; store client secret in tenant env (SOPS) |
| User invited (console) | Through the identity service: create the user, or link one that belongs to no other company, keeping its id; add to the organization; grant `member` on `lc-<slug>` + realm role; then the governance DB row; then the Keycloak "execute actions" email (set password + configure MFA). An email already in another company answers one generic 409, so a caller can't learn where |
| User joins via customer IdP | First login creates the user in the org (organization domain mapping); a console "pending approval" or auto-approve setting decides whether the `member` role is granted |
| Seat assignment (tier) | Stored in governance DB `seats` (not in Keycloak); the gateway reads it |
| User disabled | Disable in Keycloak and end their sessions, through the identity service. The gateway and console-api read the user's status on every request, so there's no cache to clear: they refuse at once. LibreChat's own session lasts until it expires, but it can't reach a model |
| Tenant suspended | Disable client `lc-<slug>`; gateway key revoked; LibreChat container stopped (data kept) |

## 4. Console authorisation (RBAC)

Rules are enforced in `console-api` from the token's roles and organization. `provider_admin` also requires membership of the `provider` organization, so one wrongly assigned role can't make a customer's user a provider admin. Every query also passes `tenant_id` into Postgres RLS (`SET app.tenant_id`).

| Role | Scope |
| --- | --- |
| `provider_admin` | All tenants; may impersonate read-only (audited) |
| `tenant_admin` | Own tenant |
| `dept_manager` | Own departments (many-to-many `department_managers`) |
| `user` | Self (user portal) |

## 5. Gateway authentication

- LibreChat → gateway:
  - `Authorization: Bearer <tenant gateway key>`, where the key is `sk-sme-<slug>-<random>`, stored hashed (argon2id) in `gateway_keys`.
  - Headers: `X-User-Id`, `X-User-Email`, `X-Conversation-Id`.
- The gateway trusts user headers **only** when the key is a tenant key and the request comes from a tenant's own network. Phase 2 hardening: per-tenant mTLS or a signed header.
- The gateway maps `X-User-Email` → `users` row in the same tenant. Unknown email → 403 with code `user_not_provisioned`.
- API keys for customers (phase 2 public API): `sk-sme-u-...`, bound to user + scopes; same table.

## 6. Access rules (per tenant, set in the console)

| Rule | Storage (`access_rules`) | Enforcement |
| --- | --- | --- |
| IP allowlist (CIDRs) | `ip_allowlist text[]` | Traefik `ipAllowList` middleware `<slug>-ipallow`, which Traefik polls every 5 s from `console-api` (`/internal/traefik`, not routed publicly), in the same answer as the company's route (LLD-01 §2.2a). No files or Docker access are needed. If Traefik can't load it when it starts, the company's host answers 404: it fails closed. Source IP from Cloudflare `CF-Connecting-IP` via Traefik `forwardedHeaders.trustedIPs` = Cloudflare ranges (P1-44) |
| Allowed countries | `countries char(2)[]` (default `{TR}` + EU) | Cloudflare WAF custom rule per hostname (Cloudflare API from provisioner); the gateway also checks `CF-IPCountry` as defence in depth |
| Require MFA | `mfa_required bool` (always true) | Keycloak flow (local accounts), for the whole realm. The console shows it as always on, and nothing can turn it off per company. For IdP users, a policy check of `amr`/`acr` claims (best effort, not built) |
| Session idle / max | `session_idle_min`, `session_max_h` | Keycloak client session settings for `lc-<slug>`, through the identity service. Up to the realm's 30 minutes and 10 hours, because a client can only shorten them |
| Trusted devices (phase 2) | `device_trust enum(off, cf_access, mtls)` | Cloudflare Access application per tenant, or Traefik mTLS |

Change flow:

1. console-api validates the change: CIDR syntax, and the caller's own address must be on a non-empty list, unless `force` says they've been warned.
2. In one transaction, it sets Keycloak's session limits, writes the rules and the audit log, which holds counts rather than addresses. If Keycloak fails, nothing changes.
3. Traefik picks up the list within 5 seconds, so the new rule is live in well under 60. The allowlist covers the company's LibreChat. The console stays reachable, so an admin can undo a mistake.
4. Countries are stored, and apply once Cloudflare is connected (P1-29).

## 7. Admin plane access (our staff)

- Keycloak admin console, Grafana, Lago UI, Postgres and SSH are reachable only on the Tailscale network (or through Cloudflare Access).
- Traefik routers for these hosts carry an `ipAllowList` of Tailscale CGNAT `100.64.0.0/10`.
- Provider admins log in to the console with the `provider_admin` role + WebAuthn mandatory.

## 8. Acceptance criteria

- A user of tenant A cannot log in to tenant B's LibreChat (Keycloak returns an error, or LibreChat rejects the missing role).
- Changing a tenant's IP allowlist blocks a non-listed IP within 60 seconds; the audit row records who changed it.
- Disabling a user stops their next gateway request (403) within 5 seconds.
- A local-account user without MFA is forced to enrol a passkey or OTP at first login.
