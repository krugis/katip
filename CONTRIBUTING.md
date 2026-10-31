# Contributing to Kâtip

Thank you for helping! Please read [CLAUDE.md](CLAUDE.md) first. It contains the engineering rules that apply to everyone (humans and AI coding agents):

- tenant isolation;
- no personal data in logs;
- pinned versions;
- allowed licences.

## Workflow

1. Pick or open an issue that maps to a task in [docs/TRACKER.md](docs/TRACKER.md).
2. Create a branch `feat/<task-id>-short-name` (for example `feat/P1-09-quota-lua`).
3. Keep the PR small. Include tests, and update docs and tracker status in the same PR.
4. CI must be green: lint, typecheck, tests, licence check, secret scan.

## Contributor Licence Agreement (CLA)

Kâtip is dual-licensed: AGPL-3.0 plus a commercial licence (see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md)). To keep that possible, every contributor signs our CLA:

- You keep the copyright to your contribution.
- You grant the project maintainers a licence to distribute it under the AGPL **and** under commercial terms.

A CLA bot will ask you to sign on your first pull request. **The CLA text is being finalised** (tracker task P0-11). Until the bot is active, maintainers will not merge external contributions.

## Code rules (short)

- TypeScript (Node 22, ESM, strict). Every new source file starts with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Do not copy code from GPL/AGPL projects or from sources whose licence would block dual licensing.
- Only add dependencies under MIT, Apache-2.0, BSD, ISC, MPL-2.0, 0BSD or CC0.
- Tests: Vitest. PII recognizers and policy rules need Turkish examples.
