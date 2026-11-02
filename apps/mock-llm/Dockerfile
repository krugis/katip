# SPDX-License-Identifier: AGPL-3.0-only
# Build from repo root: context is passed by compose (build.context: ../..).
# Uses `pnpm deploy` to produce a self-contained production bundle.
FROM node:22.23.1-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/mock-llm/package.json apps/mock-llm/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/mock-llm apps/mock-llm
RUN pnpm --filter @katip/mock-llm build \
 && pnpm deploy --legacy --filter=@katip/mock-llm --prod /deploy/mock-llm
FROM node:22.23.1-alpine
RUN corepack enable && adduser -S -u 10001 app
COPY --from=build /deploy/mock-llm /app/mock-llm
USER app
EXPOSE 8080
CMD ["node", "/app/mock-llm/dist/server.js"]
