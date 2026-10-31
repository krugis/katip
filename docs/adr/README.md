# Architecture decision records

| ID | Decision | Status |
| --- | --- | --- |
| [ADR-001](adr-001-use-the-official-librechat-image-pinned-no-fork.md) | Use the official LibreChat image, pinned; no fork | Accepted |
| [ADR-002](adr-002-one-librechat-instance-per-tenant-cell-model-on-sh.md) | One LibreChat instance per tenant (cell model), on shared databases (one Mongo database per tenant) | Accepted for phase 1 |
| [ADR-003](adr-003-typescript-policy-gateway-in-front-of-litellm.md) | TypeScript policy gateway in front of LiteLLM | Accepted |
| [ADR-004](adr-004-keycloak-with-one-realm-organizations-tenants-one-.md) | Keycloak with one realm; Organizations = tenants; one OIDC client per tenant instance | Accepted |
| [ADR-005](adr-005-docker-compose-on-vms-hetzner-eu-turkish-data-cent.md) | Docker Compose on VMs (Hetzner EU; Turkish data centre for the KVKK region) | Accepted |
| [ADR-006](adr-006-agpl-3-0-commercial-licence-dual-licensing-for-our.md) | AGPL-3.0 + commercial licence (dual licensing) for our modules; contributors sign a CLA | Accepted (31 Oct 2026) |
| [ADR-007](adr-007-secrets-in-sops-age-encrypted-env-files-openbao-la.md) | Secrets in SOPS + age encrypted env files; OpenBao later for per-tenant keys | Accepted |
| [ADR-008](adr-008-traefik-behind-cloudflare-as-gateway-and-ingress.md) | Traefik behind Cloudflare as gateway and ingress | Accepted |
| [ADR-009](adr-009-expose-company-knowledge-deep-research-and-studio-.md) | Expose company knowledge, deep research and Studio flows to LibreChat as MCP servers | Accepted (phase 2) |
| [ADR-010](adr-010-usage-metering-in-our-own-postgres-ledger-valkey-c.md) | Usage metering in our own Postgres ledger (+ Valkey counters); Lago only for invoicing | Accepted |
| [ADR-011](adr-011-default-model-deepseek-v4-flash-via-zero-retention.md) | Default model DeepSeek V4 Flash via zero-retention providers (DeepInfra); the DeepSeek first-party endpoint is blocked | Accepted |

New ADRs: copy the format, next free number, status `Proposed` until accepted by the product owner.
