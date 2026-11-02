# LLD-07 — Tenant provisioning (instance per tenant)

`apps/provisioner` is a TypeScript CLI with an internal HTTP API used by console-api. It makes tenant lifecycle operations repeatable and idempotent.

## 1. Commands

```bash
pnpm tenant:create  --slug acme --name "ACME A.Ş." --plan business --seats 10 --region eu [--kvkk] [--domain ai.acme.com.tr]
pnpm tenant:suspend --slug acme
pnpm tenant:resume  --slug acme
pnpm tenant:delete  --slug acme --confirm acme      # soft delete; data purge after 30 days via job
pnpm tenant:upgrade --slug acme | --all             # roll LibreChat version / config
pnpm tenant:render  --slug acme                     # re-render config only (dry run shows diff)
```

## 2. `tenant:create` steps

Each step is idempotent, checks for existing state, and records progress in the `jobs` table.

1. Validate the slug (unique, `^[a-z0-9-]{3,32}$`) and plan; insert `tenants`, `subscriptions`, `seats`, a default `tenant_policies`, and `access_rules` (MFA required, countries TR + EU).
2. **Keycloak:**
   - create organization `<slug>`;
   - create client `lc-<slug>` (redirect URIs, web origins) and client role `member`;
   - create the first tenant admin user and send the invite email.
3. **MongoDB:** create database `lc_<slug>` and a user with `readWrite` on that database only.
4. **Network and search:** create the network `<project>_t_<slug>` with a subnet from the tenant's slug, and attach Traefik, the gateway and Mongo to it. Generate a key for the tenant's own Meilisearch, which starts with its compose project: LibreChat has no index prefix setting (LLD-01 §2.2).
5. **LiteLLM:**
   - create a team `<slug>` with a max budget (backstop = 150% of the plan's expected monthly cost);
   - create a virtual key for the gateway's calls on behalf of this tenant;
   - store it.
6. **Gateway key:** generate `sk-sme-<slug>-…` and store its hash in `gateway_keys`. The plaintext goes into the tenant env only.
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
    - a gateway call with the tenant key on `fast` returns 200 (counted as a system event, not billed).
12. Write an audit entry and mark the job done.

**Never delete and recreate a Keycloak user.** A new user gets a new id, and LibreChat refuses a known email arriving with a new id, which locks that person out. Disable users instead.

**Today:** `pnpm dev:up` does these steps for the tenants in `katip.config.yaml`, and the provisioner is not built yet (P1-21).

Rollback: if any step fails after step 3, run the compensating steps in reverse (delete client, drop database, revoke keys). The job ends `failed` with the step name.

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
