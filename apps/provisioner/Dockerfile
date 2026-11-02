# SPDX-License-Identifier: AGPL-3.0-only
# Build from repo root. Runs without the Docker socket (LLD-07 §2).
FROM node:22.23.1-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/console-api/package.json apps/console-api/
COPY apps/mock-llm/package.json apps/mock-llm/
COPY apps/policy-gateway/package.json apps/policy-gateway/
COPY apps/provisioner/package.json apps/provisioner/
COPY packages/shared/package.json packages/shared/
COPY packages/pii/package.json packages/pii/
COPY packages/policy-engine/package.json packages/policy-engine/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/provisioner apps/provisioner
RUN pnpm --filter "@katip/provisioner..." build \
 && pnpm deploy --legacy --filter=@katip/provisioner --prod /deploy/provisioner

FROM node:22.23.1-alpine
RUN corepack enable && adduser -S -u 10001 app
COPY --from=build /deploy/provisioner /app/provisioner
USER app
CMD ["node", "/app/provisioner/dist/cli.js"]
