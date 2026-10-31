# ADR-010: Usage metering in our own Postgres ledger (+ Valkey counters); Lago only for invoicing

- **Status:** Accepted
- **Date:** 2026-10-31

## Decision

Usage metering in **our own Postgres ledger** (+ Valkey counters); **Lago** only for invoicing

## Rationale and consequences

OpenMeter needs Kafka and ClickHouse, which is too heavy for phase 1

Source: [docs/DESIGN.md](../DESIGN.md) §3.
