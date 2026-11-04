# SPDX-License-Identifier: AGPL-3.0-only
# Build from repo root. Uses `pnpm deploy` to produce a self-contained production bundle.
FROM node:22.23.1-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/billing-bridge/package.json apps/billing-bridge/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/billing-bridge apps/billing-bridge
RUN pnpm --filter "@katip/billing-bridge..." build \
 && pnpm deploy --legacy --filter=@katip/billing-bridge --prod /deploy/billing-bridge

FROM node:22.23.1-alpine
RUN corepack enable && adduser -S -u 10001 app
COPY --from=build /deploy/billing-bridge /app/billing-bridge
WORKDIR /app/billing-bridge
USER app
EXPOSE 8095
CMD ["node", "/app/billing-bridge/dist/server.js"]
