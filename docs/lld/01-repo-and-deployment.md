# LLD-01 — Repository, environments and deployment

## 1. Monorepo layout

```
librechat-sme/
├─ apps/
│  ├─ policy-gateway/      # Fastify, OpenAI-compatible proxy: policy, PII, routing, metering (LLD-03)
│  ├─ console-api/         # REST API for the console + user portal (LLD-04)
│  ├─ console/             # React + Refine UI: provider, tenant admin, dept manager, user portal
│  ├─ provisioner/         # CLI + small API: create/suspend/delete tenants (LLD-07)
│  ├─ billing-bridge/      # usage → Lago, Lago invoices → e-Fatura provider (LLD-06)
│  ├─ knowledge/           # phase 2: MCP server for company knowledge (LLD-08)
│  ├─ studio/              # phase 2: flow designer UI (LLD-09)
│  └─ studio-runner/       # phase 2: BullMQ workers executing flows
├─ packages/
│  ├─ db/                  # Drizzle schema, migrations, RLS policies (LLD-05)
│  ├─ shared/              # zod schemas, types, error helpers, logger, otel setup
│  ├─ policy-engine/       # pure functions: rule evaluation, quota math, routing (unit-tested)
│  └─ pii/                 # Presidio client, placeholder mapping, streaming un-masker
├─ infra/
│  ├─ compose/
│  │  ├─ platform.yml      # shared services (one per environment)
│  │  ├─ tenant.tmpl.yml   # template rendered per tenant by provisioner
│  │  ├─ dev.yml           # dev overrides (hot reload, mailpit, test providers)
│  │  └─ tenants/          # rendered tenant files (gitignored in prod; generated)
│  ├─ traefik/             # static config, dynamic middlewares (ipAllowList per tenant)
│  ├─ keycloak/            # realm export, themes (TR/EN), organization config
│  ├─ litellm/             # Dockerfile (pinned + checksum), dev config template, hooks/
│  ├─ presidio/            # analyzer config, TR recognizers (YAML), NLP model config
│  ├─ librechat/           # librechat.tmpl.yaml, .env template
│  ├─ monitoring/          # prometheus, grafana dashboards, loki, alert rules
│  ├─ env/                 # *.example.env, *.enc.env (SOPS)
│  └─ ansible/             # host hardening, docker install, backups, tailscale
├─ docs/                   # this design set, ADRs in docs/adr/
├─ .github/workflows/      # ci.yml, images.yml, deploy.yml
├─ turbo.json, pnpm-workspace.yaml, package.json
└─ CLAUDE.md
```

## 2. Docker Compose topology

### 2.1 Platform services (`infra/compose/platform.yml`, one set per environment)

| Service | Image (pin exact version) | Ports (internal) | Volumes | Notes |
| --- | --- | --- | --- | --- |
| traefik | traefik:v3.x | 80, 443 (only public ports) | certs, dynamic config | Cloudflare origin certs or Let's Encrypt DNS challenge. No Docker socket and no way to Docker: routes come from a file and `console-api` (§2.2) |
| keycloak | quay.io/keycloak/keycloak:26.x | 8080 | – (DB in Postgres) | `KC_HOSTNAME=auth.<domain>`, admin console only via Tailscale |
| postgres | pgvector/pgvector:pg16 | 5432 | pgdata | DBs: `governance`, `keycloak`, `litellm`, `lago` |
| mongodb | mongo:7 | 27017 | mongodata | One database per tenant (`lc_<slug>`), with a login limited to it. On each tenant's network |
| valkey | valkey/valkey:8 | 6379 | valkey | AOF on; BullMQ + counters + LiteLLM cache. Password required; `backend` network only |
| litellm | ghcr.io/<org>/litellm:<pinned> (self-built) | 4000 | – | Internal only; master key used only by the gateway and provisioner |
| presidio-analyzer | mcr.microsoft.com/presidio-analyzer:<pinned> | 3000 | – | Custom TR recognizers mounted |
| presidio-anonymizer | mcr.microsoft.com/presidio-anonymizer:<pinned> | 3000 | – | Optional; masking is done in `packages/pii` |
| policy-gateway | ghcr.io/<org>/policy-gateway | 8080 | – | Stateless, scale with `--scale` |
| console-api, console | ghcr.io/<org>/… | 8081 / 80 | – | |
| provisioner | ghcr.io/<org>/provisioner | 8082 | docker.sock (read/write, see security note) | Runs `docker compose` for tenant files |
| billing-bridge | ghcr.io/<org>/billing-bridge | – | – | BullMQ worker |
| lago (api, worker, clock, front) | getlago/* pinned | 3000 | – | Phase 1 milestone M3 |
| searxng | searxng/searxng pinned | 8080 | – | Unmodified (AGPL) |
| code-interpreter | pinned (Apache-2.0 sandbox used by LibreChat) | – | – | Phase 1b; resource limits per run |
| seaweedfs | chrislusf/seaweedfs pinned | 8333 (S3) | seaweed | Files, backups staging |
| prometheus, grafana, loki, promtail, node-exporter, cadvisor | pinned | – | – | Admin UIs only via Tailscale |

**Security note on the provisioner and docker.sock.** The provisioner is the only container with `docker.sock`. It runs on an internal network and requires a provider-admin token. Plan: replace it with a Docker socket proxy that allows only compose operations (tracker P1-35).

### 2.2 Per-tenant services (`infra/compose/tenant.tmpl.yml`, rendered per tenant)

```yaml
# rendered as infra/compose/tenants/<slug>.yml — project name: <project>-<slug>
services:
  meili-${SLUG}:                                                 # one per tenant, see below
    image: getmeili/meilisearch:${MEILI_VERSION}
    env_file: [ "../../env/tenants/${SLUG}.meili.env" ]
    volumes: [ "meili-${SLUG}:/meili_data" ]
    networks: [ tenant ]
  lc-${SLUG}:
    image: ghcr.io/danny-avila/librechat:${LIBRECHAT_VERSION}   # official image (verify registry path)
    restart: unless-stopped
    env_file: [ "../../env/tenants/${SLUG}.env" ]               # rendered + SOPS-encrypted at rest
    volumes:
      - ../../librechat/rendered/${SLUG}.librechat.yaml:/app/librechat.yaml:ro
      - lc-uploads-${SLUG}:/app/uploads
    networks: [ tenant ]
    deploy: { resources: { limits: { memory: 1g, cpus: "1.0" } } }
  ragdb-${SLUG}:                                                 # vectors, one per tenant, see below
    image: pgvector/pgvector:${PG_VERSION}                       # the same pin as the platform's Postgres
    env_file: [ "../../env/tenants/${SLUG}.ragdb.env" ]
    volumes: [ "ragdb-${SLUG}:/var/lib/postgresql/data" ]
    networks: [ tenant ]
    deploy: { resources: { limits: { memory: 256m } } }
  rag-${SLUG}:                                                   # file search, one per tenant, see below
    image: ghcr.io/danny-avila/librechat-rag-api-dev-lite:${RAG_API_VERSION}
    env_file: [ "../../env/tenants/${SLUG}.rag.env" ]
    networks: [ tenant ]
    deploy: { resources: { limits: { memory: 768m, cpus: "1.0" } } }
volumes:
  lc-uploads-${SLUG}: {}
  meili-${SLUG}: {}
  ragdb-${SLUG}: {}
networks:
  tenant: { name: "${PROJECT}_t_${SLUG}", external: true }
```

- **Why a Meilisearch per tenant:** LibreChat's index names are fixed (`convos`, `messages`) with no prefix setting, and its sync deletes documents missing from its own Mongo database, so a shared instance would lose other tenants' search data. It costs about 45 MB idle.
- **Why a RAG API and vector database per tenant:** the service checks one JWT secret, and in the version LibreChat v0.8.7 can use, any valid token can list and read every file it holds (LLD-08 §1.1). Neither has a route from outside.
- **What they cost**, measured on their own on 3 Nov 2026, with the memory limits above and no LibreChat:
  | | RAG API | Its Postgres | Together |
  | --- | --- | --- | --- |
  | Idle, empty | 188 MiB | 45 MiB | **233 MiB** |
  | After a 2.3 MB text file (1,501 chunks, 11 MB on disk) | 219 MiB | 59 MiB | **278 MiB** |

  Large or scanned PDFs weren't measured. The image is 540 MB, once per host.
- The `${SLUG}-ipallow` middleware comes from `console-api`, through Traefik's HTTP provider, in the same answer as the company's route.
- When the tenant has no allowlist, the middleware is a pass-through (`0.0.0.0/0`) (LLD-02 §6).

### 2.2a Routes

Traefik faces the internet and has no access to Docker. Inspecting a container shows its environment, so even read-only access would give a broken-into Traefik every company's secrets. There are no Traefik labels.

- **The platform's routes** are in `infra/traefik/dynamic/routes.yml`: `auth.`, `mailpit.`, `console.`, and `/api` on `console.` to `console-api`. Traefik fills in the domain from its `KATIP_BASE_DOMAIN`. They don't depend on `console-api`.
- **A company's route** comes from `console-api` at `/internal/traefik`, polled every 5 s: router `<slug>` for `Host(<slug>.<domain>)` on `websecure` with TLS, its middlewares `<slug>-ipallow@http`, `ratelimit-user@file` and `secure-headers@file`, and a service at `http://lc-<slug>:3080`. Traefik resolves that name over the company's own network, which it's attached to when the company is created (`connectPlatformToTenant`, kept by the generated compose file).
- **Only active companies get one.** Status is what counts, not whether containers run, and the route and its allowlist arrive in one answer, so neither exists without the other. A slug that isn't `^[a-z0-9-]{3,32}$`, or is a platform host, gets none.
- **The answer is never empty.** Traefik ignores an empty answer, and refuses an empty `routers` or `services`, keeping the last one either way. That would leave the last company's route open after it's suspended. So those are left out, and a middleware that nothing uses stays in.
- **Who can read it.** It lists every company's host and allowlist. `console-api` isn't on a company's network, its public route only covers `/api`, and Traefik's own port (API, metrics) listens on `127.0.0.1` inside its container, because Traefik is on every company's network. `isolation.mjs` checks all three from a company's LibreChat. The dashboard's API is `docker exec katip-traefik-1 wget -qO- http://127.0.0.1:8080/api/http/routers`.

What happens when (run on the real pinned image, with stubs behind it, on 3 Nov 2026):

| Situation | A company's host | Platform hosts |
| --- | --- | --- |
| Company created or resumed | 200 once LibreChat answers. Its route appears within about 5 s, and 502 until the container is up. `startTenant` waits up to 180 s for 200 | – |
| Company suspended or deleted | Containers stop at once, so 502, then 404 within about 5 s | – |
| `console-api` restarting, down, or answering 500 or garbage | The last good answer stays, including allowlists. A company suspended meanwhile keeps its route, answering 502 as its containers are stopped, and loses it on the next good answer | `auth.` and `console.` work. `/api` answers 502 |
| Traefik restarts while `console-api` is down | 404: no route without its allowlist, the same as before | Work, so login's own pages stay up. A company's login stays out until `console-api` is back |
| `console-api` comes back | Routes return within about 5 s, also after 150 s away | – |

### 2.3 Networks

| Network | Members | Purpose |
| --- | --- | --- |
| `edge` | traefik, console, console-api, keycloak, mailpit | Public entry through Traefik |
| `backend` | platform services, not traefik or LibreChat | DBs, gateway, LiteLLM, Presidio, Valkey; no published ports |
| `<project>_t_<slug>` | one tenant's LibreChat, Meilisearch, RAG API and vector database, plus traefik, policy-gateway and mongodb | The only network a tenant touches. Other tenants, the platform's Postgres, Valkey, LiteLLM and Presidio aren't on it |
| `egress-llm` | litellm only | Outbound to LLM providers; firewall egress allowlist (optional, phase 2) |

Tenant networks are not internal, because users can add MCP tools that need the internet. Subnets are `<project.tenant_network_prefix>.<n>.0/24`, starting from a hash of the slug and stepping to the next free one, and Docker keeps what was chosen. They're set explicitly because Docker's default address pools allow only about 30 networks. The bootstrap adds tenant networks to platform services through a generated compose file (`infra/compose/rendered/tenants.yml`), so they survive a recreate.

### Testing with a real model on this machine

Set `KATIP_LOCAL_LLM_UPSTREAM` in `katip.env` to an OpenAI-compatible server's `host:port`, such as llama.cpp at `127.0.0.1:8080`, then run `pnpm dev:up` and `pnpm test:local-llm`. Models with no provider key then use it instead of the mock. Without it, installs and CI keep the mock, which is quick and predictable.

Such a server usually listens on localhost only, which containers can't reach. So `scripts/setup/local-llm-relay.mjs` runs on the host's network, and takes connections from the `backend` network only, so a tenant's LibreChat can't reach the model around the gateway. It's a small Node script, to avoid adding a GPL tool to the stack.

## 3. Environments

| Env | Host | Contents | Data |
| --- | --- | --- | --- |
| `local` | laptop | `pnpm dev:up` = platform + the tenants in `katip.config.yaml` (`demo` and `acme`); mailpit; fake provider (`mock-llm`) optional | throwaway |
| `dev` | AX42 (shared), compose project `sme-dev` | latest `main` | synthetic |
| `test` | AX42 (same host), project `sme-test` | release candidates; e2e + load tests | synthetic |
| `pilot` / `prod-eu` | Hetzner (EU) | tagged releases | real; daily backups |
| `prod-tr` | Turkish DC | tagged releases + vLLM GPU node | real; KVKK tenants |

## 4. CI/CD (GitHub Actions)

1. **`ci.yml`** runs on every PR:
   - `pnpm install --frozen-lockfile`
   - lint, typecheck, unit tests
   - integration tests (Testcontainers: Postgres, Valkey)
   - license check (`license-checker` allowlist: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, 0BSD, CC0-1.0)
2. **`images.yml`** runs on merge to `main`:
   - build images with Docker Buildx;
   - generate an SBOM with Syft and scan with Trivy (fail on HIGH/CRITICAL unless waived in `.trivyignore` with an expiry);
   - push to GHCR with tags `sha-<git>` and `main`;
   - build LiteLLM from a pinned version with a checksum.
3. **`deploy.yml`** runs manually or on a tag:
   - SSH over Tailscale to the host;
   - `docker compose pull && up -d` for the platform;
   - `provisioner upgrade --all` rolls tenants with a health check.
4. **Renovate** keeps images and packages updated. It groups minor and patch updates weekly. LibreChat and LiteLLM upgrades are manual-review only.

### 4.1 Deploying on the dev stack, and going back (P1-71)

`deploy.yml` above doesn't exist yet. What exists, on one host: `pnpm run deploy` and `pnpm deploy:back` (`scripts/setup/deploy.mjs`, `deploy-lib.mjs`, `backups.mjs`). `pnpm deploy` without `run` is pnpm's own command. Runbooks: [deploy](../runbooks/deploy.md), [rollback](../runbooks/rollback.md). Neither has run on a real stack.

- **Deploy:** refuses a dirty tree; dumps the governance database and every `lc_*` Mongo database to `.katip/backups/<timestamp>-<sha>/`; tags the running images `:deploy-<sha>`; runs `dev:up --redo=config,build,governance-db,aiplane,tenant,smoke,isolation`, the same machinery as by hand; records it in `.katip/deploys.json`. A failed dump stops it before anything changes. `deploy.keep_backups` (default 5) sets how many are kept.
- **Back:** restores the kept tags, checks out their commit, runs `dev:up` without build or pull. With `--restore-data`, and a typed confirmation, it also restores the dump. Going back across a migration or a LibreChat version is refused without it. Which migrations differ comes from the newest `created_at` in `drizzle.__drizzle_migrations`, before the deploy and now, against the journal.
- **Not P1-42.** The dump is on the same disk, is not encrypted, and leaves out Keycloak, uploads, vectors and secrets.
- `pnpm test:backup` runs the dump and restore commands for real against throwaway containers of the pinned images, with the real migrations and row-level security.

`pnpm dev:rollback` is the uninstall, not this. Its rule for what counts as test data is in [the runbook](../runbooks/rollback.md) and `scripts/setup/rollback-guard.mjs`.

## 5. Configuration and secrets

- Env files:
  - `infra/env/<env>.enc.env` is encrypted with SOPS (age keys: one per developer + one per host).
  - The provisioner renders `infra/env/tenants/<slug>.env` and stores it encrypted.
- Required platform variables are documented in `infra/env/platform.example.env`. Each app validates its env with Zod at boot.
- Rotate the LiteLLM master key, the Keycloak admin password and provider API keys every 90 days (runbook in LLD-10).

## 6. Acceptance criteria for this LLD

- `pnpm dev:up` on a clean laptop brings up the platform + `demo` tenant in under 10 minutes.
- Logging in at `https://demo.localhost` via Keycloak and sending a chat message routes through the gateway; the usage row is visible in Postgres.
- No container except Traefik publishes a host port (`docker ps` check in CI e2e).
