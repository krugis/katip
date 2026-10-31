# TRACKER — Kâtip

How to use this tracker:

- **Status** is one of `todo`, `doing`, `review`, `done` or `blocked`.
- Update the row in the same PR as the work, and put the PR link in Notes.
- Priority: **P0** = must for the milestone; **P1** = should; **P2** = could.
- "Done when" summarises the acceptance criteria; the full criteria are in the referenced LLD.

## Phase 0 — Foundations (Sprint S1)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-01 | Monorepo skeleton: pnpm workspaces, Turborepo, TS strict, ESLint, Prettier, Vitest | 01 | P0 | review | – | `pnpm lint && pnpm typecheck && pnpm test` pass on empty apps | Monorepo, TS strict, ESLint, Prettier, Vitest |
| P0-02 | CI `ci.yml`: install, lint, typecheck, tests, licence check, gitleaks | 01 | P0 | review | P0-01 | PR shows all checks; a test secret fails the build | CI: build, lint, typecheck, test, SPDX, licences; secret scan via secretlint (MIT) instead of gitleaks |
| P0-03 | Dev compose `platform.yml` + `dev.yml`: traefik, postgres+pgvector, mongo, meili, valkey, keycloak, mailpit | 01 | P0 | todo | P0-01 | `pnpm dev:up` healthy in under 10 min; only Traefik publishes ports | |
| P0-04 | Pin LibreChat version; `tenant.tmpl.yml`, `librechat.tmpl.yaml`; script renders `demo` tenant | 01, 07 | P0 | todo | P0-03 | `https://demo.localhost` loads LibreChat | |
| P0-05 | LiteLLM self-built image (pinned tag + checksum) + `config.yaml` with 2 standard + 1 premium + 1 embedding model | 03 | P0 | doing | P0-03 | `curl litellm:4000/v1/chat/completions` works internally | config.yaml + pinned, checksum-verified Dockerfile; model ids to verify; compose pending |
| P0-06 | SOPS + age; `*.example.env`; Zod env validation in `packages/shared` | 01, 10 | P0 | doing | P0-01 | App fails fast on missing env; encrypted env decrypts in dev | Zod env validation done; SOPS/age setup pending |
| P0-07 | `packages/shared`: pino logger (PII-safe), OTel setup, problem+json errors | 01 | P0 | doing | P0-01 | Used by a hello-world Fastify app with a trace in console exporter | PII-safe pino logger + problem+json/OpenAI errors done; OTel pending |
| P0-08 | Mock OpenAI-compatible provider (streaming, configurable errors and latency) for tests | 03 | P0 | review | P0-01 | Can simulate 500/timeout; used in integration tests | apps/mock-llm: echo, SSE streaming, failure injection |
| P0-09 | Dev/test host (Hetzner AX42): Ansible base hardening, Tailscale, Docker | 10 | P1 | todo | – | SSH only via Tailscale; external scan shows 443 only | |
| P0-10 | Licence setup: `LICENSE` (AGPL-3.0), `COMMERCIAL-LICENSE.md` (how to obtain), SPDX headers + CI check, `docs/adr/` with ADR-001…011 | DESIGN | P0 | review | P0-01 | Files merged; SPDX check fails a file without header | LICENSE, COMMERCIAL-LICENSE, SPDX check, ADR-001…011 |
| P0-11 | CLA: text (lawyer review), CLA Assistant bot on the GitHub org, `CONTRIBUTING.md` | DESIGN | P1 | todo | P0-10 | First external PR is asked to sign; unsigned PR can't merge | Owner: product owner + counsel |

## Phase 1 — Sellable core

### M1 Chat through the governed router (S2–S3)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-01 | `policy-gateway` skeleton; `/v1/chat/completions` stream passthrough to LiteLLM | 03 | P0 | review | P0-05, P0-07 | Stream works from curl and LibreChat | apps/policy-gateway: stream + non-stream passthrough |
| P1-02 | Gateway auth: `gateway_keys` (argon2id), tenant resolution, Valkey cache | 03, 05 | P0 | doing | P1-01, P1-17* | Wrong key 401; correct key resolves tenant | In-memory store with SHA-256 key hashes; Postgres + argon2id with P1-17 |
| P1-03 | User identification from `X-User-Email`; status checks | 03 | P0 | review | P1-02 | Unknown or disabled user 403 with code | X-User-Email → user, status checks, cross-tenant test |
| P1-04 | `model_catalog` + aliases; `GET /v1/models` filtered by tenant | 03, 05 | P0 | doing | P1-02 | Tenant without KVKK add-on doesn't see `tr-local` | Aliases + filtered /v1/models; catalog in code until P1-17 |
| P1-05 | LibreChat custom endpoint "SME AI" with user and conversation headers; e2e check | 03 | P0 | todo | P0-04, P1-03 | E2E asserts headers arrive at the gateway | Verify placeholders on pinned version |
| P1-06 | `packages/policy-engine`: router rules v1 | 03 | P0 | review | P1-04 | Unit tests for every rule priority | packages/policy-engine router rules v1 + tests |
| P1-07 | Fallback across candidates with retry budget | 03 | P0 | review | P1-06, P0-08 | Forced 500 → fallback model answers; audit `fallback=true` | Fallback across candidates on 5xx/429/network errors |
| P1-08 | `/v1/embeddings` via gateway; LibreChat RAG API points to gateway | 03, 08 | P1 | todo | P1-01 | File upload + question works; embedding usage metered | |
| P1-09 | Quota reserve/settle Lua scripts; block / downgrade / overage behaviours | 03, 06 | P0 | doing | P1-06 | Tests for all three modes; LibreChat shows 429 message | Reserve/settle + block/downgrade/overage in memory; Valkey Lua pending |
| P1-10 | Effective policy load + cache + `policy.changed` invalidation | 03, 04 | P0 | todo | P1-02 | Policy change applies within 30 s | |
| P1-11 | Presidio analyzer deploy + TR recognizers (TCKN, IBAN, phone, VKN) | 03 | P0 | doing | P0-03 | Recognizer unit tests incl. checksums | TR recognizers (TCKN, VKN, IBAN, phone, card, email) in packages/pii; Presidio NER for PERSON pending |
| P1-12 | `packages/pii`: masking + streaming un-masker | 03 | P0 | review | P1-11 | Provider sees placeholders; user sees originals | Masking with stable placeholders + streaming un-masker |
| P1-13 | PII fixture set (≥ 200 TR sentences) + recall test in CI | 03 | P0 | todo | P1-12 | Recall ≥ 0.95 structured, ≥ 0.80 PERSON | |
| P1-14 | `usage_events` writer + Valkey outbox replay | 03, 05 | P0 | todo | P1-09, P1-17 | Postgres down → events replayed later, none lost | |
| P1-15 | Gateway metrics (Prometheus) + OTel traces (no prompt text) | 03 | P1 | todo | P1-01 | Dashboard shows requests, tokens, latency by tenant | |
| P1-16 | M1 demo + load baseline (50 concurrent streams, mock provider) | 03 | P0 | todo | P1-01…15 | p95 overhead under 120 ms; CPU under 1 vCPU | |

### M2 Governance console and portal (S4–S5)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-17 | `packages/db` schema v1, migrations, seeds (plans, catalog, rules, demo) | 05 | P0 | todo | P0-03 | Migrate from empty in CI | |
| P1-18 | RLS policies + RLS test suite | 05 | P0 | todo | P1-17 | Cross-tenant read/write impossible in tests | |
| P1-19 | Keycloak realm export: roles, organizations, `sme-browser` flow (passkeys + MFA), TR/EN theme | 02 | P0 | todo | P0-03 | Local user forced to enrol MFA | |
| P1-20 | `console-api` skeleton: OIDC, RBAC middleware, problem+json, OpenAPI | 04 | P0 | todo | P1-17, P1-19 | RBAC matrix test scaffold | |
| P1-21 | Provisioner `tenant:create` steps 1–6 (DB, Keycloak, Mongo, Meili, LiteLLM, gateway key) | 07 | P0 | todo | P1-17, P1-19 | Idempotent re-run | |
| P1-22 | Provisioner render + start + smoke (steps 7–12) + compensation | 07 | P0 | todo | P1-21 | New tenant usable in under 3 min; failure leaves no orphans | |
| P1-23 | Provisioner suspend / resume / delete (+ purge job) / upgrade | 07 | P1 | todo | P1-22 | Lifecycle e2e test | |
| P1-24 | Users API: invite, CSV import, tier, department, role, disable (+ Keycloak sync, session revoke) | 02, 04 | P0 | todo | P1-20 | Disabled user blocked within 5 s | |
| P1-25 | Console UI shell: Refine, OIDC, i18n TR/EN, role-based navigation | 04 | P0 | todo | P1-20 | Each role sees only its areas | |
| P1-26 | Tenant admin: overview, users, departments | 04 | P0 | todo | P1-24, P1-25 | Invite 3 users → they log in within 2 min | |
| P1-27 | Tenant admin: models and policies (TenantPolicy editor) | 04 | P0 | todo | P1-10, P1-25 | Downgrade setting live in gateway within 30 s | |
| P1-28 | Access rules API + Traefik ipallow writer + lock-out protection | 02 | P0 | todo | P1-22 | Non-listed IP blocked within 60 s; audit row | |
| P1-29 | Cloudflare country rules automation (per tenant hostname) | 02 | P1 | todo | P1-28 | Rule visible in Cloudflare; gateway double-check | |
| P1-30 | `usage_daily` job + usage API + usage screens + CSV export | 04, 05 | P0 | todo | P1-14 | Numbers match `usage_events` sums | |
| P1-31 | Department manager area | 04 | P1 | todo | P1-30 | Other departments 404 | |
| P1-32 | User portal: my usage, requests, sessions/MFA links, privacy export | 04 | P0 | todo | P1-30 | Usage visible within 1 min of a chat | |
| P1-33 | Audit log API + screen (tenant + provider) | 04, 05 | P1 | todo | P1-20 | All mutations audited | |
| P1-34 | M2 e2e (Playwright): invite → login → chat → usage visible → policy change effective | 04 | P0 | todo | P1-26…33 | Green in CI against dev stack | |

### M3 Billing, security, operations (S6–S7)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-35 | Docker socket proxy for provisioner (compose ops only) | 01, 10 | P0 | todo | P1-22 | Provisioner can't run arbitrary containers | |
| P1-36 | Lago deploy; plans, add-ons, metered charges configured | 06 | P0 | todo | P0-03 | Test customer + subscription created | |
| P1-37 | `billing-bridge`: hourly usage → Lago events (idempotent); seat sync | 06 | P0 | todo | P1-36, P1-14 | Replay doesn't double-bill | |
| P1-38 | `EInvoiceProvider` interface + manual mode (+ provider adapter when decided) | 06 | P1 | blocked | e-Fatura decision | Draft PDF in TRY with FX rate | Manual mode can ship first |
| P1-39 | Payment adapter (iyzico / PayTR) + dunning | 06 | P1 | blocked | payment decision | Recurring charge in sandbox | |
| P1-40 | TCMB FX rate daily job (`fx_rates`) | 06 | P1 | todo | P1-17 | Rate stored daily; alert if missing | |
| P1-41 | Budget threshold alerts (50/80/100%): email + console banner | 03, 06 | P0 | todo | P1-09 | One alert per threshold per month | |
| P1-42 | Backups: wal-g/pg_dump, mongodump per tenant, restic → Storage Box; monthly restore test | 10 | P0 | todo | P0-09 | Restore test passes; alert if skipped | |
| P1-43 | Monitoring: Prometheus, Grafana, Loki, exporters, alert rules (LLD-10 §5) | 10 | P0 | todo | P0-09 | Alerts reach phone in test | |
| P1-44 | Edge hardening: Cloudflare WAF, rate limits, origin certs, security headers | 10 | P0 | todo | P0-09 | External scan: 443 only; headers A-grade | |
| P1-45 | Pilot load test: 200 simulated users; measure RAM per tenant instance | 01, 07 | P0 | todo | P1-34 | Report updates sizing + ADR-002 cost | |
| P1-46 | Security review: threat model, CI gates (Trivy, gitleaks), book external pentest | 10 | P0 | todo | P1-44 | Threat model doc; pentest date set | |
| P1-47 | Provider margin dashboard | 06 | P1 | todo | P1-37 | Margin per tenant/month shown | |
| P1-48 | Runbooks: deploy, rollback, secret rotation, restore, incident | 10 | P0 | todo | P1-42 | Tabletop exercise done | |
| P1-49 | KVKK docs: DPA template, sub-processor list, privacy texts (with counsel) | 10 | P0 | todo | – | Reviewed by counsel | Owner: product owner |
| P1-50 | Pilot kit: Turkish admin guide, user quick start, short video | – | P1 | todo | P1-34 | Kit shared with pilot customers | |
| P1-51 | Status page + external uptime checks | 10 | P1 | todo | P1-43 | Status page public | |
| P1-52 | Release `v1.0.0-pilot` on pilot host | 01 | P0 | todo | P1-35…51 | Tagged, deployed, smoke-tested | |

### Pilot (S8–S9)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-53 | Onboard pilot tenant 1 (incl. Entra ID / Google SSO) | 02, 07 | P0 | todo | P1-52 | Users active ≥ 2 weeks | |
| P1-54 | Onboard pilot tenants 2–3 | 07 | P0 | todo | P1-53 | – | |
| P1-55 | Collect metrics; update pricing spreadsheets (tokens per user, RAM per tenant, support hours) | – | P0 | todo | P1-54 | Spreadsheets updated with real numbers | |
| P1-56 | Pilot retrospective + Phase 2 re-plan | – | P0 | todo | P1-55 | Updated phase plan (kept outside the public repo) | |

## Phase 2 — Studio and knowledge (epics; break down at re-plan)

| ID | Epic | LLD | Prio | Status |
| --- | --- | --- | --- | --- |
| P2-01 | Knowledge service + MCP server | 08 | P0 | todo |
| P2-02 | Connector: SharePoint / OneDrive (Graph delta) | 08 | P0 | todo |
| P2-03 | Connector: Google Drive | 08 | P1 | todo |
| P2-04 | OpenFGA permission sync + filtered retrieval | 08 | P0 | todo |
| P2-05 | Deep research service (GPT Researcher + MCP + run quota) | 08 | P0 | todo |
| P2-06 | Studio designer UI (React Flow) | 09 | P0 | todo |
| P2-07 | Studio runner (LangGraph.js + BullMQ + checkpoints) | 09 | P0 | todo |
| P2-08 | Studio triggers: schedule, webhook (email, file later) | 09 | P0 | todo |
| P2-09 | Studio human approval + notifications | 09 | P0 | todo |
| P2-10 | Studio MCP exposure + 4 templates | 09 | P0 | todo |
| P2-11 | ERP connectors: Logo, Mikro, Netsis (premium plugins) | 09 | P1 | todo |
| P2-12 | Desktop app (Tauri), signing, updater, MDM packages | 11 | P1 | todo |
| P2-13 | Trusted devices (Cloudflare Access / mTLS) per tenant | 02 | P2 | todo |
| P2-14 | Production 3-VM topology + Langfuse | 01, 10 | P1 | todo |
| P2-15 | Learned router (RouteLLM-style) behind a feature flag | 03 | P2 | todo |
| P2-16 | Public API: per-user API keys with scopes | 02, 03 | P2 | todo |
| P2-17 | Scale-to-zero for idle tenants | 07 | P2 | todo |

## Phase 3 — KVKK region and reach (epics)

| ID | Epic | LLD | Prio | Status |
| --- | --- | --- | --- | --- |
| P3-01 | TR region host + vLLM GPU node + `tr-local` alias | 01, 03 | P0 | todo |
| P3-02 | Domestic LLM partner integration | 03 | P1 | todo |
| P3-03 | Outlook add-in | 11 | P1 | todo |
| P3-04 | Word / Excel add-ins | 11 | P2 | todo |
| P3-05 | Teams app | 11 | P2 | todo |
| P3-06 | Mobile apps (Capacitor) | 11 | P2 | todo |
| P3-07 | Dedicated instance offering | 07 | P1 | todo |
| P3-08 | OpenBao per-tenant keys | 10 | P2 | todo |
| P3-09 | ISO 27001 readiness (if required by customers) | 10 | P2 | todo |
| P3-10 | Revisit ADR-002: shared multi-tenant LibreChat | DESIGN | P2 | todo |
