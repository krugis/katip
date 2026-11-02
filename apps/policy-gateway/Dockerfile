# SPDX-License-Identifier: AGPL-3.0-only
# Build from repo root: context is passed by compose (build.context: ../..).
# Uses `pnpm deploy` to produce a self-contained production bundle.
FROM node:22.23.1-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/mock-llm/package.json apps/mock-llm/
COPY apps/policy-gateway/package.json apps/policy-gateway/
COPY packages/shared/package.json packages/shared/
COPY packages/pii/package.json packages/pii/
COPY packages/policy-engine/package.json packages/policy-engine/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @katip/mock-llm build \
 && pnpm --filter @katip/policy-gateway build \
 && pnpm deploy --legacy --filter=@katip/mock-llm --prod /deploy/mock-llm \
 && pnpm deploy --legacy --filter=@katip/policy-gateway --prod /deploy/policy-gateway

FROM node:22.23.1-alpine
RUN corepack enable && adduser -S -u 10001 app
COPY --from=build /deploy/mock-llm /app/mock-llm
COPY --from=build /deploy/policy-gateway /app/policy-gateway
USER app
EXPOSE 8080
CMD ["node", "/app/policy-gateway/dist/server.js"]
