# ADR-002: One LibreChat instance per tenant (cell model), on shared databases (one Mongo database per tenant)

- **Status:** Accepted for phase 1
- **Date:** 2026-10-31

## Decision

**One LibreChat instance per tenant** (cell model), on shared databases (one Mongo database per tenant)

## Rationale and consequences

Strong isolation: LibreChat sharing features (agents, prompts, "all users") must not leak across companies. Cost: about 0.4–0.6 GB RAM per tenant instance (verify in pilot). Revisit when upstream LibreChat tenant support matures; its docs already mention tenant placeholders

**Update, November 2026.** Meilisearch is no longer shared: each tenant runs its own, because LibreChat has no index prefix setting and its sync deletes documents missing from its own database. Each tenant also has its own Mongo login and Docker network. Mongo itself stays shared, with one database per tenant. The RAG API and its vector database are per tenant too (P1-08, LLD-08 §1.1).

Source: [docs/DESIGN.md](../DESIGN.md) §3.
