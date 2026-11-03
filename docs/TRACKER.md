# TRACKER — Kâtip

How to use this tracker:

- **Status** is one of `todo`, `doing`, `review`, `done` or `blocked`.
- Update the row in the same PR as the work, and put the PR link in Notes.
- Priority: **P0** = must for the milestone; **P1** = should; **P2** = could.
- "Done when" summarises the acceptance criteria; the full criteria are in the referenced LLD.

## Phase 0 — Foundations (Sprint S1)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-01 | Monorepo skeleton: pnpm workspaces, Turborepo, TS strict, ESLint, Prettier, Vitest | 01 | P0 | done | – | `pnpm lint && pnpm typecheck && pnpm test` pass on empty apps | Monorepo, TS strict, ESLint, Prettier, Vitest (#1) |
| P0-02 | CI `ci.yml`: install, lint, typecheck, tests, licence check, gitleaks | 01 | P0 | done | P0-01 | PR shows all checks; a test secret fails the build | CI: build, lint, typecheck, test, SPDX, licences; secret scan via secretlint (MIT) instead of gitleaks (#1) |
| P0-03 | Dev compose `platform.yml` + `dev.yml`: traefik, postgres+pgvector, mongo, meili, valkey, keycloak, mailpit | 01 | P0 | done | P0-01 | `pnpm dev:up` healthy in under 10 min; only Traefik publishes ports | Via one-stop bootstrap (P0-12…16); 11 containers healthy; only traefik publishes (80/443/127.0.0.1:9090) |
| P0-04 | Pin LibreChat version; `tenant.tmpl.yml`, `librechat.tmpl.yaml`; script renders `demo` tenant | 01, 07 | P0 | done | P0-03 | `https://demo.localhost` loads LibreChat | LibreChat v0.7.8; rendered by bootstrap; SME AI custom endpoint active (Keycloak OIDC flow itself is P1-19) |
| P0-05 | LiteLLM self-built image (pinned tag + checksum) + `config.yaml` with 2 standard + 1 premium + 1 embedding model | 03 | P0 | done | P0-03 | `curl litellm:4000/v1/chat/completions` works internally | 1.79.3 pinned, wheel sha256 verified at build; 6 models configured (3 std + 2 prem + emb), mock-routed in dev; gateway smoke passes through it |
| P0-06 | SOPS + age; `*.example.env`; Zod env validation in `packages/shared` | 01, 10 | P0 | doing | P0-01 | App fails fast on missing env; encrypted env decrypts in dev | Zod env validation done; katip.example.env + generated katip.env done; SOPS/age setup still pending |
| P0-07 | `packages/shared`: pino logger (PII-safe), OTel setup, problem+json errors | 01 | P0 | done | P0-01 | Used by a hello-world Fastify app with a trace in console exporter | PII-safe pino logger + problem+json/OpenAI errors (#1); OTel setup in `@katip/shared/tracing`, used by the gateway (P1-15) |
| P0-08 | Mock OpenAI-compatible provider (streaming, configurable errors and latency) for tests | 03 | P0 | review | P0-01 | Can simulate 500/timeout; used in integration tests | apps/mock-llm: echo, SSE streaming, failure injection (#1). Still open: 500 is tested, but nothing tests the gateway timing out |
| P0-09 | Dev/test host (Hetzner AX42): Ansible base hardening, Tailscale, Docker | 10 | P1 | todo | – | SSH only via Tailscale; external scan shows 443 only | |
| P0-10 | Licence setup: `LICENSE` (AGPL-3.0), `COMMERCIAL-LICENSE.md` (how to obtain), SPDX headers + CI check, `docs/adr/` with ADR-001…011 | DESIGN | P0 | done | P0-01 | Files merged; SPDX check fails a file without header | LICENSE, COMMERCIAL-LICENSE, SPDX check, ADR-001…011 (#1) |
| P0-11 | CLA: text (lawyer review), CLA Assistant bot on the GitHub org, `CONTRIBUTING.md` | DESIGN | P1 | todo | P0-10 | First external PR is asked to sign; unsigned PR can't merge | Owner: product owner + counsel |

### Phase 0.5 — One-stop bootstrap (S1b)

Single-command dev bootstrap: one master config file, one secrets file, rich TUI with progress, interrupt → keep-or-rollback, idempotent resume. An interrupted install must leave a usable partial stack (secrets always complete, each finished layer independently functional).

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-12 | Master config `katip.config.yaml` + `infra/env/katip.example.env`; all compose/template inputs render from these two files; secrets auto-generated once, never overwritten | 01 | P0 | done | P0-01 | Every rendered artifact derives from config + env | katip.config.yaml + katip.example.env; secrets fill-once into gitignored katip.env; finished in P0-17…P0-21 |
| P0-13 | Infra pieces: traefik static+dynamic config, dev TLS certs, postgres init (keycloak/litellm DBs), app Dockerfiles, dev LiteLLM config render, tenant + librechat templates | 01, 03, 07 | P0 | done | P0-12 | `docker compose config` validates platform+dev+tenant | traefik.yml/dev.yml, dynamic middlewares + demo ipallow, initdb script, pnpm-deploy Dockerfiles, tenant.tmpl.yml + librechat.tmpl.yaml; subsumes compose part of P0-05 |
| P0-14 | `scripts/setup/` (`pnpm dev:up`): TUI (progress bar, step states, logs), SIGINT → keep/rollback prompt, state in `.katip/setup-state.json`, idempotent resume; `dev:down`/`dev:status`/`dev:rollback` | 01 | P0 | done | P0-13 | Interrupt at any step; keep → usable partial stack; re-run resumes; rollback cleans | Verified: mid-run SIGINT marks step partial, resume completes, rollback removes all |
| P0-15 | Demo tenant render + LibreChat pin via bootstrap (custom endpoint → gateway) | 03, 07 | P0 | done | P0-13 | `https://demo.localhost` loads; chat routes through gateway | LibreChat v0.7.8 pinned; SME AI endpoint loaded; gateway smoke passes end-to-end |
| P0-16 | E2E verify from clean state + smoke tests (gateway chat/models, tenant URL) | 01, 03 | P0 | done | P0-14, P0-15 | Clean run green; smoke tests pass | Full cold run green (11 containers healthy); chat via gateway returns Echo; lint/typecheck/tests/spdx/secrets/licences all pass |

### Phase 0.6 — Unified setup (S1c)

One script, one config file and one env file set up every building block. Each building block added later must install through `pnpm dev:up` and take its settings from these two files.

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0-17 | Images, project name, domain and tenant slug all come from `katip.config.yaml`; unknown settings rejected; project renamed to `katip` | 01 | P0 | done | P0-12 | Changing a value in the config changes what runs | Compose reads images and names from the config; config validated at start; test fails if compose pins an image; `SME AI` label and `sk-sme-` key prefix unchanged (LLD-02) (#6) |
| P0-18 | Presidio built by the bootstrap; spaCy model pinned and checksum-verified | 01, 03 | P0 | done | P1-11 | Clean install builds it with a verified model | Version and wheel sha256 in the config; image tagged by version, not `:dev` (#6) |
| P0-19 | Models and tenant settings have one source | 01, 05 | P0 | done | P0-17 | Static LiteLLM config removed; DB catalog and tenant match the config | `models` feeds LiteLLM and `model_catalog`; seats, plan, KVKK add-on and PII policy applied; provider keys now reach LiteLLM; `seed.ts` and `DEFAULT_CATALOG` keep defaults for tests only (#6) |
| P0-20 | Re-running `dev:up` applies config and env changes | 01 | P0 | done | P0-14 | Edit config, re-run, change is live | Hash of config + env; renaming a live project or slug is refused (#6) |
| P0-21 | Gateway readiness and useful failure logs | 01, 03 | P0 | done | P1-04 | Gateway unhealthy until migrated; failed step's log has the error | `/readyz`; platform step no longer starts the AI plane; bearer tokens redacted from command errors (#6) |
| P0-22 | `dev` / `prod` profiles, SOPS for production secrets | 01, 10 | P0 | todo | P0-06, P0-17…21 | One script installs either profile | Dev keeps the plaintext `katip.env`; design first |

## Phase 1 — Sellable core

### M1 Chat through the governed router (S2–S3)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-01 | `policy-gateway` skeleton; `/v1/chat/completions` stream passthrough to LiteLLM | 03 | P0 | done | P0-05, P0-07 | Stream works from curl and LibreChat | apps/policy-gateway: stream + non-stream passthrough (#1) |
| P1-02 | Gateway auth: `gateway_keys` (argon2id), tenant resolution, Valkey cache | 03, 05 | P0 | done | P1-01, P1-17* | Wrong key 401; correct key resolves tenant | DbTenantStore (Postgres): prefix lookup + argon2id verify, 60 s Valkey cache (`gw:auth:*`); @katip/shared gateway-key module (generate/hash/verify); bootstrap governance-db step migrates+seeds and stores the demo key; dev.yml runs gateway on DATABASE_URL+VALKEY_URL; Testcontainers tests incl. revoked/expired/prefix-collision; live stack verified (#4) |
| P1-03 | User identification from `X-User-Email`; status checks | 03 | P0 | done | P1-02 | Unknown or disabled user 403 with code | X-User-Email → user, status checks, cross-tenant test (#1) |
| P1-04 | `model_catalog` + aliases; `GET /v1/models` filtered by tenant | 03, 05 | P0 | done | P1-02 | Tenant without KVKK add-on doesn't see `tr-local` | DbCatalogStore: model_catalog + router_rules from Postgres, 30 s TTL refresh (edits live without restart); gateway routes /v1/models and chat through it when DATABASE_URL is set; tests: KVKK filtering, DB-driven routing, catalog edit picked up; live stack verified (#4) |
| P1-05 | LibreChat custom endpoint "SME AI" with user and conversation headers; e2e check | 03 | P0 | done | P0-04, P1-03 | E2E asserts headers arrive at the gateway | LibreChat upgraded to v0.8.7, since v0.7.8 didn't fill the placeholders; the `dev:up` smoke test chats through LibreChat and checks the usage row has the right user and conversation (#8) |
| P1-06 | `packages/policy-engine`: router rules v1 | 03 | P0 | done | P1-04 | Unit tests for every rule priority | packages/policy-engine router rules v1 + tests (#1) |
| P1-07 | Fallback across candidates with retry budget | 03 | P0 | done | P1-06, P0-08 | Forced 500 → fallback model answers; audit `fallback=true` | Fallback across candidates on 5xx/429/network errors (#1) |
| P1-08 | `/v1/embeddings` via gateway; LibreChat RAG API points to gateway | 03, 08 | P1 | todo | P1-01 | File upload + question works; embedding usage metered | |
| P1-09 | Quota reserve/settle Lua scripts; block / downgrade / overage behaviours | 03, 06 | P0 | review | P1-06 | Tests for all three modes; LibreChat shows 429 message | Valkey Lua reserve/settle (atomic, month bucketed, 26 h TTL) wired in server.ts; 6 store tests + e2e (#5). Still open: "LibreChat shows 429 message" not demonstrated |
| P1-10 | Effective policy load + cache + `policy.changed` invalidation | 03, 04 | P0 | done | P1-02 | Policy change applies within 30 s | DbPolicySource: tenant + department override merge (PII tighten-only), 30 s Valkey cache, `policy.changed` pub/sub bump invalidates immediately; `publishPolicyChanged` helper in shared; e2e alias toggling verified (#5) |
| P1-11 | Presidio analyzer deploy + TR recognizers (TCKN, IBAN, phone, VKN) | 03 | P0 | done | P0-03 | Recognizer unit tests incl. checksums | TR recognizers (TCKN, VKN, IBAN, phone, card, email) in packages/pii (#1); Presidio analyzer (self-built, xx_ent_wiki_sm) adds PERSON NER via optional PRESIDIO_URL, on analyzer failure logs `pii_detector_failed` and follows per-tenant `pii.onDetectorFailure` (allow by default, or block with 503) (#5) |
| P1-12 | `packages/pii`: masking + streaming un-masker | 03 | P0 | done | P1-11 | Provider sees placeholders; user sees originals | Masking with stable placeholders + streaming un-masker (#1) |
| P1-13 | PII fixture set (≥ 200 TR sentences) + recall test in CI | 03 | P0 | done | P1-12 | Recall ≥ 0.95 structured, ≥ 0.80 PERSON | Structured data in CI with no services, names with `pnpm test:pii-names`. Found names at 0.44, so the model changed: now 0.99 whole on 270 names, 0 of 30 clean sentences wrong. Made-up sentences, so real text will score lower |
| P1-14 | `usage_events` writer + Valkey outbox replay | 03, 05 | P0 | done | P1-09, P1-17 | Postgres down → events replayed later, none lost | DbUsageSink: direct insert, Valkey outbox on connection failure, background drain (5 s), idempotent uuid replay, dead-letter list; 4 store tests + e2e (#5) |
| P1-15 | Gateway metrics (Prometheus) + OTel traces (no prompt text) | 03 | P1 | review | P1-01 | Dashboard shows requests, tokens, latency by tenant | Metrics on their own port with a token, traces, and a Grafana dashboard whose queries `pnpm test:metrics` checks on a real Prometheus. Grafana itself runs with P1-43 |
| P1-16 | M1 demo + load baseline (50 concurrent streams, mock provider) | 03 | P0 | todo | P1-01…15 | p95 overhead under 120 ms; CPU under 1 vCPU | |
| P1-57 | Gateway request allow list: scan every text field, drop unknown fields; tool arguments stay masked; images and files allowed and logged | 03 | P0 | done | P1-12 | Each request field tested: nothing leaves unmasked except what's decided | Owner's decisions 2026-11-02: gateway is the one control point, MCP stays open to users; tool arguments stay masked; images and files allowed for now (P3-11) (#9) |
| P1-58 | Conversation placeholders: the same value gets the same placeholder across requests, with nothing stored | 03 | P0 | done | P1-57 | A placeholder from earlier tool arguments still resolves on a later request | Keyed hash of tenant, conversation and value (`PII_TOKEN_KEY`); no personal data in Valkey (#10) |
| P1-59 | Tenant stores and secrets: tenant list in config, own Mongo login, own Meilisearch, own secrets | 01, 07 | P0 | done | P1-19 | Two tenants install from one config; each Mongo login is limited to its own database | LibreChat has no index prefix setting and its sync deletes documents missing from its own database, so one shared Meilisearch would lose other tenants' search data (#11) |
| P1-60 | Per-tenant networks and a Valkey password | 01, 10 | P0 | done | P1-59 | A tenant's LibreChat reaches only Traefik, the gateway, Mongo and its own search | Subnets derived from the slug under `project.tenant_network_prefix`; internet stays open because users can add MCP tools (#12) |
| P1-61 | Gateway runs as a limited role, so row-level security applies | 03, 05 | P0 | done | P1-18 | A query with no tenant filter can't cross tenants on the gateway's own connection | Was connecting as a superuser, which bypasses RLS; tests now connect as `katip_gateway` (#13) |
| P1-62 | Cross-tenant checks on every install; design docs updated | 01, 05, 07, 10 | P0 | done | P1-59…61 | Breaking a boundary fails `dev:up` | Network, Mongo, search, gateway, Postgres, Valkey and login across tenants; confirmed by deliberately breaking the network boundary (#14) |
| P1-63 | Tool-call log: record which tools models ask to call, by name | 03, 05 | P0 | done | P1-57 | Names recorded per call, arguments never; checked through LiteLLM on every install | Column on `usage_events`, so it shares the outbox and tenant scoping; per-tenant allow and block rules are not built (#15) |

### M2 Governance console and portal (S4–S5)

| ID | Task | LLD | Prio | Status | Depends | Done when | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P1-17 | `packages/db` schema v1, migrations, seeds (plans, catalog, rules, demo) | 05 | P0 | done | P0-03 | Migrate from empty in CI | Drizzle schema (23 tables, citext emails, bigint micro-USD), single migration 0000_schema_v1 + RLS + katip_provider role, seed (5 plans incl. kvkk_addon, 7 models, 7 rules, demo tenant + 3 users); Testcontainers CI test: migrate-from-empty + idempotency + RLS isolation; applied to dev governance DB (#3) |
| P1-18 | RLS policies + RLS test suite | 05 | P0 | done | P1-17 | Cross-tenant read/write impossible in tests | tenant_isolation policy (USING + WITH CHECK) on all 19 tenant-owned tables, FORCE RLS; audit_log append-only (UPDATE/DELETE revoked); tests: cross-tenant insert rejected, cross-tenant update affects 0 rows, policy presence on every table, audit_log tamper rejected (#3) |
| P1-19 | Keycloak realm: roles, organizations, login flow (passkeys + MFA), TR/EN theme; LibreChat login through it | 02 | P0 | done | P0-03 | Local user forced to enrol MFA | Applied by `dev:up` through the Admin API, not a realm export, so re-runs update it; login smoke test in `dev:up`: MFA forced, second login asks for the code, non-member refused (#7). Not verified: passkey login and how the theme looks |
| P1-20 | `console-api` skeleton: OIDC, RBAC middleware, problem+json, OpenAPI | 04 | P0 | done | P1-17, P1-19 | RBAC matrix test scaffold | Keycloak token check, deny by default, 404 across tenants, `katip_console` under RLS; matrix test fails if a route is missing from it; `dev:up` logs in and calls it with a real token (#17) |
| P1-21 | Provisioner `tenant:create` steps 1–6 (DB, Keycloak, Mongo, network and search key, gateway key) | 07 | P0 | done | P1-17, P1-19 | Idempotent re-run | LiteLLM step moved to P1-64. `dev:up` uses the same path, so every install tests it; no Docker socket in the container |
| P1-22 | Provisioner render + start + smoke (steps 7–12) + compensation | 07 | P0 | done | P1-21 | New tenant usable in under 3 min; failure leaves no orphans | Lago and Cloudflare steps wait for their milestones. Smoke checks the gateway key, not a chat call, until system events exist |
| P1-23 | Provisioner suspend / resume / delete (+ purge job) / upgrade | 07 | P1 | done | P1-22 | Lifecycle e2e test | `pnpm test:lifecycle`. Owner's decisions, 2 Nov 2026: anonymise on purge, 30-day wait, slugs never reused. Counsel to confirm (P1-49) |
| P1-64 | LiteLLM team and virtual key per tenant, as a second spending limit | 07, 03 | P1 | todo | P1-21 | A tenant over its backstop budget is refused by LiteLLM even if the gateway's quota check fails | Deferred by the owner, 2026-11-02: LiteLLM needs a database, and the gateway a way to store per-tenant keys |
| P1-65 | Daily schedule for `tenant:purge-due`, and the retention job for usage events and the audit log | 07, 10 | P1 | review | P1-23, P1-42 | A deleted tenant is purged on time with nobody running a command; an alert fires if the job fails or stops running | `pnpm tenant:daily` (LLD-07 §2c). The schedule is off until the owner sets `jobs.daily_at`, so the acceptance isn't met yet. The provider console says if it failed or stopped; a phone alert needs P1-43 |
| P1-66 | Console: department policy overrides and per-entity PII choices | 04 | P1 | done | P1-27 | A department can only tighten the company's policy, in the screen and the API | The gateway already applies them; split from P1-26 and P1-27 |
| P1-67 | Test against a real model on this machine: relay, `pnpm test:local-llm` | 01, 03 | P1 | done | P1-01 | Real answers, streaming, masking and tool calls through the gateway; a tenant can't reach the model directly | Owner's request, 2 Nov 2026: also shows the product runs on a local LLM |
| P1-68 | Include a person's chats in their data export | 04, 10 | P1 | todo | P1-32 | A person's export holds their chats and nobody else's | **Owner's decision needed:** this gives a service read access to chats in Mongo, which nothing has today |
| P1-69 | Carry out one person's deletion: Keycloak, LibreChat data, anonymised rows | 04, 07, 10 | P1 | done | P1-32 | After it, nothing identifies them, and totals still add up | Admin approves, `pnpm tenant:forget-due` carries it out (LLD-07 §2b). `pnpm test:console` scans every LibreChat collection afterwards. Nothing runs the job on a schedule yet (P1-65) |
| P1-70 | Enforce chat retention: a company's chats older than its period are deleted (default 12 months) | 07, 10 | P1 | todo | P1-65 | Old chats go on time, from the search index too; a company can set its period | LLD-10 §8 sets the default, and nothing enforces it |
| P1-24 | Users API: invite, CSV import, tier, department, role, disable (+ Keycloak sync, session revoke) | 02, 04 | P0 | done | P1-20 | Disabled user blocked within 5 s | Keycloak rights live in an internal identity service, owner's decision 2 Nov 2026. `pnpm test:users`. Reset MFA (LLD-04) and manager-department links aren't in this task |
| P1-25 | Console UI shell: Refine, OIDC, i18n TR/EN, role-based navigation | 04 | P0 | done | P1-20 | Each role sees only its areas | `pnpm test:console`: each role in a real browser, and a real invite email through to LibreChat |
| P1-26 | Tenant admin: overview, users, departments | 04 | P0 | done | P1-24, P1-25 | Invite 3 users → they log in within 2 min | CSV import now runs in the background. Overview has no cost until billing brings a customer price. Budgets are stored, not enforced yet. Department policy overrides are P1-66, reset MFA isn't built |
| P1-27 | Tenant admin: models and policies (TenantPolicy editor) | 04 | P0 | done | P1-10, P1-25 | Downgrade setting live in gateway within 30 s | Checked through to the real gateway in `pnpm test:console`. Department overrides and per-entity PII are P1-66; the overage cap in LLD-04 isn't in the gateway yet |
| P1-28 | Access rules API + Traefik ipallow writer + lock-out protection | 02 | P0 | done | P1-22 | Non-listed IP blocked within 60 s; audit row | Traefik polls rules over HTTP instead of a file writer, so no Docker access is needed. Countries wait for Cloudflare (P1-29). MFA is always on, not a per-company switch |
| P1-29 | Cloudflare country rules automation (per tenant hostname) | 02 | P1 | todo | P1-28 | Rule visible in Cloudflare; gateway double-check | |
| P1-30 | `usage_daily` job + usage API + usage screens + CSV export | 04, 05 | P0 | done | P1-14 | Numbers match `usage_events` sums | Rolled up per request rather than nightly. Tokens only. The monthly PDF and charts in LLD-04 aren't built |
| P1-31 | Department manager area | 04 | P1 | done | P1-30 | Other departments 404 | Approving records the decision and doesn't change access yet. Budget alerts come with P1-41; people raise requests from P1-32 |
| P1-32 | User portal: my usage, requests, sessions/MFA links, privacy export | 04 | P0 | done | P1-30 | Usage visible within 1 min of a chat | Export covers the governance database, not chats (P1-68). Deletion is a request the admin carries out by hand (P1-69). Default alias isn't built |
| P1-33 | Audit log API + screen (tenant + provider) | 04, 05 | P1 | done | P1-20 | All mutations audited | Client IPs aren't recorded yet. Our provider admins' own log entries with no company aren't shown |
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
| P1-41 | Budget threshold alerts (50/80/100%): email + console banner | 03, 06 | P0 | done | P1-09 | One alert per threshold per month | A company's tokens. Department budgets wait for a customer price (P1-37). Needs a real email sender to reach anyone in production |
| P1-42 | Backups: wal-g/pg_dump, mongodump per tenant, restic → Storage Box; monthly restore test | 10 | P0 | todo | P0-09 | Restore test passes; alert if skipped | |
| P1-43 | Monitoring: Prometheus, Grafana, Loki, exporters, alert rules (LLD-10 §5) | 10 | P0 | todo | P0-09 | Alerts reach phone in test | Must alert on the gateway's `pii_detector_failed` log event (P1-11); until then it is only an error log |
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
| P3-11 | Filter uploaded documents before they are sent: find open source building blocks or write our own (check licences) | 03 | P1 | todo |
