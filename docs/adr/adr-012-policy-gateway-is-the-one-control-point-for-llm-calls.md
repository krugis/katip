# ADR-012: The policy gateway is the one control point for LLM calls

- **Status:** Accepted
- **Date:** 2026-11-02

## Decision

The **policy gateway** is the one control point for what reaches a model. Users stay free to add any MCP tool, so features in LibreChat are not locked down to protect data.

## Rationale and consequences

User-added MCP tools and generated flows can't be controlled in advance, but every model call still passes through the gateway, including those made for tools. So:

- Requests pass an allow list, and every text field is scanned.
- Tool arguments stay masked, so tools receive placeholders. A tool that needs a real value won't work until there's a per-tenant list of trusted tools.
- Images and files are allowed for now, unscanned and logged (P3-11).

The gateway can't see what a tool does with what it receives, including an MCP server calling its own LLM, or personal data the detectors miss. LibreChat's built-in tools using a user's own key are LLM calls outside the gateway, and should be turned off in config.

Source: [docs/DESIGN.md](../DESIGN.md) §3 and §7, [LLD-03](../lld/03-policy-gateway-and-router.md) §5.
