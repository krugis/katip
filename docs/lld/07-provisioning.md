# LLD-07 — Tenant provisioning (instance per tenant)

`apps/provisioner` makes tenant lifecycle operations repeatable and idempotent. It's a TypeScript CLI today; the internal HTTP API for console-api comes when the console needs it, and needs the Docker socket proxy (P1-35) first.

**How it runs.** `pnpm tenant:create` runs on the host and does the Docker work. It then starts the provisioner in a container on the `backend` network, for Postgres (as `katip_provider`), Keycloak (as the `katip-provisioner` service account, limited to our realm) and Mongo. So that container needs no Docker socket. `pnpm dev:up` uses the same path for the tenants in `katip.config.yaml`, so every install tests it.

**Where tenants live.** The database is the source of truth. The config only lists which tenants dev should create. On a host, `infra/env/tenants/<slug>.secrets.env` marks a tenant as known, so tenants made by the CLI keep their network across `dev:up` re-runs and are removed by rollback.

**Secrets.** You edit `infra/env/katip.env` for the platform. Each tenant's secrets are generated into `infra/env/tenants/<slug>.secrets.env`, gitignored and readable only by its owner, and never edited by hand. Production will encrypt these with SOPS (P0-22).

## 1. Commands

```bash
pnpm tenant:create  --slug acme --name "ACME A.Ş." --plan business --seats 10 --admin-email it@acme.com.tr [--region eu] [--kvkk] [--domain ai.acme.com.tr]
pnpm tenant:suspend --slug acme
pnpm tenant:resume  --slug acme
pnpm tenant:delete  --slug acme --confirm acme      # soft delete; data purge after 30 days via job
pnpm tenant:upgrade --slug acme | --all             # roll LibreChat version / config
pnpm tenant:render  --slug acme                     # re-render config only (dry run shows diff)
```

## 2. `tenant:create` steps

Each step is idempotent, checks for existing state, and records progress in the `jobs` table. A re-run finishes a failed attempt. On a complete tenant it changes nothing and says "already exists". **Built so far (P1-21, P1-22):** steps 1 to 4, 6, 8 and 10 to 12. Lago (7) and Cloudflare (9) come with their own milestones. The admin's invite goes out last, after the smoke test, so nobody gets a link to something that isn't running.

1. Validate the slug (unique, `^[a-z0-9-]{3,32}$`) and plan; insert `tenants`, `subscriptions`, `seats`, a default `tenant_policies`, and `access_rules` (MFA required, countries TR + EU).
2. **Keycloak:**
   - create organization `<slug>`;
   - create client `lc-<slug>` (redirect URIs, web origins) and client role `member`;
   - create the first tenant admin user (`--admin-email`) and send the invite email: set a password and enrol MFA. The DB row is written after the email goes out, so a re-run resends a failed invite, and only then.

   A tenant's limits start as the plan's quotas × seats, pooled across the company.
3. **MongoDB:** create database `lc_<slug>` and a user with `readWrite` on that database only.
4. **Network and search:** create the network `<project>_t_<slug>` with a subnet from the tenant's slug, and attach Traefik, the gateway and Mongo to it. Generate a key for the tenant's own Meilisearch, which starts with its compose project: LibreChat has no index prefix setting (LLD-01 §2.2).
5. **LiteLLM (deferred, P1-64):** a team `<slug>` with a max budget (backstop = 150% of the plan's expected monthly cost) and a virtual key for the gateway. LiteLLM has no database today, so it has no teams or keys. The gateway enforces quotas, and LibreChat can't reach LiteLLM. What's missing is a second, independent spending limit.
6. **Gateway key:** generate `sk-sme-t-…` and store its hash in `gateway_keys`. The plaintext goes into the tenant's secrets file only. If the two ever disagree, the secrets file wins: the old key is revoked, and the new hash stored.
7. **Lago:** create the customer and subscription (from milestone M3).
8. **Render files:**
   - `infra/env/tenants/<slug>.env` (SOPS-encrypted), containing Mongo URI, OIDC client, gateway key, `CREDS_KEY`/`CREDS_IV`/`JWT_SECRET` (random per tenant, never shared), and `RAG_API_URL`;
   - `infra/env/tenants/<slug>.meili.env`, holding only that Meilisearch key;
   - `infra/librechat/rendered/<slug>.librechat.yaml` from `librechat.tmpl.yaml`, with endpoints (LLD-03 §1.2), interface settings, the MCP servers enabled by plan, and the file upload limits of the plan;
   - `infra/compose/tenants/<slug>.yml` from `tenant.tmpl.yml`;
   - Traefik middleware `<slug>-ipallow` from `access_rules`.
9. **Cloudflare:** DNS record `<slug>.<domain>` (proxied) and the WAF country rule (API token with limited zone scope).
10. **Start:** `docker compose -p <project>-<slug> -f tenants/<slug>.yml up -d`. Wait for `GET /health` (verify the LibreChat health route), timeout 180 s.
11. **Smoke test:**
    - OIDC discovery reachable;
    - the gateway accepts the tenant's key, and once the admin exists serves them `/v1/models`. A real chat call waits until the gateway can count a system event without billing it. `dev:up` runs a full login and chat for its own tenants.
12. Write an audit entry and mark the job done.

**Never delete and recreate a Keycloak user.** A new user gets a new id, and LibreChat refuses a known email arriving with a new id, which locks that person out. Disable users instead.

Rollback: if a tenant's first attempt fails before the invite, everything it made is removed in reverse: containers and volumes, Mongo database and login, Keycloak client and organization, governance rows, network, files. The job ends `failed` with the step name, and a `tenant.rollback` job records why. The rows go through the admin role from the host, because the provisioner's role can't delete anything. Failure on a tenant that already existed changes nothing, and a tenant with users is never rolled back, whatever the caller believes. If an undo step fails too, for instance with Keycloak down, the secrets file stays, and running the same command again finishes the tenant.

## 3. librechat.tmpl.yaml (key parts)

```yaml
version: 1.x.x            # match pinned LibreChat config version
cache: true
interface:
  privacyPolicy: { externalUrl: "https://<domain>/gizlilik", openNewTab: true }
  termsOfService: { externalUrl: "https://<domain>/kosullar", openNewTab: true }
  # hide endpoints other than ours; verify available interface flags for pinned version
endpoints:
  custom: [ ...LLD-03 §1.2... ]
fileConfig:
  serverFileSizeLimit: 20       # MB, by plan
mcpServers:
  # phase 2, enabled by plan:
  # company-knowledge: { type: streamable-http, url: "http://knowledge:8090/mcp", headers: { X-User-Email: "{{LIBRECHAT_USER_EMAIL}}", Authorization: "Bearer ${SME_GATEWAY_KEY}" } }
  # deep-research:     { type: streamable-http, url: "http://research:8091/mcp", headers: { ... } }
```

Also in the tenant env:

- `ENDPOINTS=custom,agents`, so only our gateway and agents are shown.
- Web search through SearXNG (`SEARXNG_INSTANCE_URL`).

Verify the exact env names on the pinned version.

## 4. Upgrades

- Each LibreChat version upgrade is first rolled to `test` tenants, then pilot, then all.
- `tenant:upgrade --all` does the following:
  - renders the new files;
  - pulls the image;
  - recreates containers one tenant at a time;
  - health-checks each tenant and stops on the first failure.
- A Mongo backup snapshot runs before every major LibreChat upgrade.

## 5. Resource notes

- Limit per LibreChat container: 1 GB RAM, 1 vCPU. Measure real idle and peak in the pilot (open question).
- Idle tenants (no login for 14 days, Starter plan): optional scale-to-zero with a Traefik "wake" page in phase 2 (Sablier or a similar proxy plugin; verify the licence).

## 6. Acceptance criteria

- `tenant:create` on the dev stack completes in under 3 minutes and the tenant admin can log in.
- Running `tenant:create` twice with the same slug is a no-op (idempotent), with exit code 0 and the message "already exists".
- `tenant:delete` followed by the purge job removes the Mongo database, the Keycloak org and client, the LiteLLM team, DNS and the compose project. The audit trail remains.
- A failed step 5 leaves no orphaned Keycloak client or Mongo database (compensation tested).
