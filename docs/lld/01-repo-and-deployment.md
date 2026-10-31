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
│  ├─ litellm/             # Dockerfile (pinned + checksum), config.yaml, hooks/
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
| traefik | traefik:v3.x | 80, 443 (only public ports) | certs, dynamic config | Cloudflare origin certs or Let's Encrypt DNS challenge |
| keycloak | quay.io/keycloak/keycloak:26.x | 8080 | – (DB in Postgres) | `KC_HOSTNAME=auth.<domain>`, admin console only via Tailscale |
| postgres | pgvector/pgvector:pg16 | 5432 | pgdata | DBs: `governance`, `keycloak`, `litellm`, `lago`, `rag` |
| mongodb | mongo:7 | 27017 | mongodata | One database per tenant (`lc_<slug>`), user per tenant |
| meilisearch | getmeili/meilisearch:v1.x | 7700 | meili | Index prefix per tenant (verify LibreChat support) or one instance per tenant if not supported |
| valkey | valkey/valkey:8 | 6379 | valkey | AOF on; BullMQ + counters + LiteLLM cache |
| litellm | ghcr.io/<org>/litellm:<pinned> (self-built) | 4000 | – | Internal only; master key used only by the gateway and provisioner |
| presidio-analyzer | mcr.microsoft.com/presidio-analyzer:<pinned> | 3000 | – | Custom TR recognizers mounted |
| presidio-anonymizer | mcr.microsoft.com/presidio-anonymizer:<pinned> | 3000 | – | Optional; masking is done in `packages/pii` |
| policy-gateway | ghcr.io/<org>/policy-gateway | 8080 | – | Stateless, scale with `--scale` |
| console-api, console | ghcr.io/<org>/… | 8081 / 80 | – | |
| provisioner | ghcr.io/<org>/provisioner | 8082 | docker.sock (read/write, see security note) | Runs `docker compose` for tenant files |
| billing-bridge | ghcr.io/<org>/billing-bridge | – | – | BullMQ worker |
| lago (api, worker, clock, front) | getlago/* pinned | 3000 | – | Phase 1 milestone M3 |
| rag-api | LibreChat RAG API pinned | 8000 | – | Shared; embeddings via gateway `/v1/embeddings` |
| searxng | searxng/searxng pinned | 8080 | – | Unmodified (AGPL) |
| code-interpreter | pinned (Apache-2.0 sandbox used by LibreChat) | – | – | Phase 1b; resource limits per run |
| seaweedfs | chrislusf/seaweedfs pinned | 8333 (S3) | seaweed | Files, backups staging |
| prometheus, grafana, loki, promtail, node-exporter, cadvisor | pinned | – | – | Admin UIs only via Tailscale |

**Security note on the provisioner and docker.sock.** The provisioner is the only container with `docker.sock`. It runs on an internal network and requires a provider-admin token. Plan: replace it with a Docker socket proxy that allows only compose operations (tracker P1-35).

### 2.2 Per-tenant services (`infra/compose/tenant.tmpl.yml`, rendered per tenant)

```yaml
# rendered as infra/compose/tenants/<slug>.yml — project name: sme-<slug>
services:
  lc-${SLUG}:
    image: ghcr.io/danny-avila/librechat:${LIBRECHAT_VERSION}   # official image (verify registry path)
    restart: unless-stopped
    env_file: [ "../../env/tenants/${SLUG}.env" ]               # rendered + SOPS-encrypted at rest
    volumes:
      - ../../librechat/rendered/${SLUG}.librechat.yaml:/app/librechat.yaml:ro
      - lc-uploads-${SLUG}:/app/uploads
    networks: [ edge, backend ]
    deploy: { resources: { limits: { memory: 1g, cpus: "1.0" } } }
    labels:
      - traefik.enable=true
      - traefik.http.routers.${SLUG}.rule=Host(`${SLUG}.${BASE_DOMAIN}`)${CUSTOM_DOMAIN_RULE}
      - traefik.http.routers.${SLUG}.tls=true
      - traefik.http.routers.${SLUG}.middlewares=${SLUG}-ipallow@file,ratelimit-user@file,secure-headers@file
      - traefik.http.services.${SLUG}.loadbalancer.server.port=3080
volumes:
  lc-uploads-${SLUG}: {}
networks:
  edge: { external: true }
  backend: { external: true }
```

- The `${SLUG}-ipallow` middleware is written to Traefik's file provider by the provisioner.
- When the tenant has no allowlist, the middleware is a pass-through (`0.0.0.0/0`) (LLD-02 §6).

### 2.3 Networks

| Network | Members | Purpose |
| --- | --- | --- |
| `edge` | traefik, console, LibreChat instances, keycloak | Reachable from Traefik only |
| `backend` | everything except traefik | DBs, gateway, LiteLLM, Presidio; no published ports |
| `egress-llm` | litellm only | Outbound to LLM providers; firewall egress allowlist (optional, phase 2) |

## 3. Environments

| Env | Host | Contents | Data |
| --- | --- | --- | --- |
| `local` | laptop | `pnpm dev:up` = platform + 1 tenant `demo`; mailpit; fake provider (`mock-llm`) optional | throwaway |
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
