# CLAUDE.md — working rules for this repository

Claude Code: read this file, then [docs/DESIGN.md](docs/DESIGN.md), then the LLD for the task you are on. Pick tasks from [docs/TRACKER.md](docs/TRACKER.md).

## Ground rules

1. **Do not modify LibreChat core.** Use the official LibreChat image, pinned by version. Integrate only through:
   - `librechat.yaml`
   - environment variables
   - custom endpoints (pointing at our gateway)
   - MCP servers
   - OIDC

   If something truly needs a core change, stop and open an ADR proposal in `docs/adr/` instead.

2. **All our code is TypeScript** (Node 22 LTS, ESM, `strict: true`). Python only exists inside third-party containers we do not modify: LiteLLM, Presidio, GPT Researcher, vLLM. The only exception is small LiteLLM hooks in `infra/litellm/hooks/`.
3. **Every LLM call goes through the policy gateway** (`apps/policy-gateway`). Nothing may call a provider, or LiteLLM, directly. This includes Studio flows, the knowledge service and background jobs.
4. **Tenant isolation is a hard requirement.**
   - Every query on governance data filters by `tenant_id`. Postgres row-level security is enabled as a second line of defence.
   - Every log line and usage event carries `tenant_id`.
5. **No personal data in logs.**
   - Log ids, never prompt text.
   - Prompts are never stored by the gateway unless the tenant opts in.
6. **Secrets** live only in SOPS-encrypted env files (`infra/env/*.enc.env`). Never commit plaintext secrets, never bake them into images, never print them.
7. **Pin versions** of every image and package, and never use `latest`. LiteLLM had compromised releases in 2026, so:
   - build its image ourselves from a pinned, checksum-verified version;
   - review each upgrade.
8. **Licences.** Our modules are dual-licensed: AGPL-3.0 + commercial (ADR-006).
   - New files in our modules get the SPDX header `// SPDX-License-Identifier: AGPL-3.0-only`.
   - Never copy code from sources whose licence would block dual licensing. That includes GPL/AGPL code from third parties: we can't relicense it commercially. Outside contributions need a signed CLA before merge.
   - Only add dependencies with permissive licences (MIT, Apache-2.0, BSD, ISC, MPL-2.0).
   - Never add Dify, n8n, Open WebUI or Elastic/BSL/SSPL-licensed code. Ask first for anything not listed.
9. **Small, reviewable changes.** One tracker task per branch and PR. Update the task status in docs/TRACKER.md in the same PR.

## Stack and commands

| Area        | Choice                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------- |
| Monorepo    | pnpm workspaces + Turborepo                                                                                       |
| Services    | Fastify, Zod (validation + OpenAPI), Drizzle ORM (Postgres), BullMQ (jobs, on Valkey), pino (logs), OpenTelemetry |
| Console UI  | React + Vite + Refine + shadcn/ui (Tailwind), react-oidc-context                                                  |
| Tests       | Vitest (unit/integration, Testcontainers for Postgres/Valkey), Playwright (e2e)                                   |
| Lint/format | ESLint + Prettier, `tsc --noEmit` in CI                                                                           |

```bash
pnpm install
pnpm dev:up            # start docker compose dev stack
pnpm dev               # watch mode for our apps
pnpm test              # unit + integration
pnpm test:e2e          # Playwright against dev stack
pnpm lint && pnpm typecheck
pnpm db:generate       # drizzle migration from schema changes
pnpm db:migrate
pnpm tenant:create --slug demo --plan business --seats 10   # provisioner CLI
```

## Conventions

- **Naming.** Folders and files use kebab-case. DB tables and columns use snake_case. API JSON uses camelCase.
- **IDs.** UUID v7 for our tables; tenants also have a human `slug` (`^[a-z0-9-]{3,32}$`).
- **Errors.** Use RFC 9457 problem+json. The gateway returns OpenAI-compatible error bodies to LibreChat.
- **Money.** Store as integer micro-USD (`bigint`); never use floats for money.
- **Time.** UTC everywhere. Usage periods are calendar months in UTC.
- **API style.**
  - REST under `/api/v1`, documented with OpenAPI generated from Zod.
  - Console APIs live in `apps/console-api`.
- **Config.** 12-factor env vars, validated at boot with Zod. Fail fast on missing config.
- **Tests.**
  - Every policy rule, quota rule and PII recognizer needs unit tests with Turkish examples.
  - Every API endpoint needs an authorisation test, including that another tenant gets 404.

## Definition of done (per task)

- [ ] Code and tests pass in CI (lint, typecheck, unit, integration)
- [ ] Acceptance criteria in docs/TRACKER.md met and demonstrated (screenshot, curl or e2e test)
- [ ] Docs updated (LLD section or README) if behaviour or config changed
- [ ] No new secrets, PII in logs, or unpinned versions
- [ ] docs/TRACKER.md status set to `done` with the PR link

## When unsure

Do not guess on these topics; stop and ask instead:

- tenant isolation
- KVKK / personal data
- licences
- billing

For any item marked **(verify)** in the LLDs, check the upstream docs for the pinned version before relying on it.
