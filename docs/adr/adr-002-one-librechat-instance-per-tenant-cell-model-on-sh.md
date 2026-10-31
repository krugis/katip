# ADR-002: One LibreChat instance per tenant (cell model), on shared databases (one Mongo database per tenant)

- **Status:** Accepted for phase 1
- **Date:** 2026-10-31

## Decision

**One LibreChat instance per tenant** (cell model), on shared databases (one Mongo database per tenant)

## Rationale and consequences

Strong isolation: LibreChat sharing features (agents, prompts, "all users") must not leak across companies. Cost: about 0.4–0.6 GB RAM per tenant instance (verify in pilot). Revisit when upstream LibreChat tenant support matures; its docs already mention tenant placeholders

Source: [docs/DESIGN.md](../DESIGN.md) §3.
