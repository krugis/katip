# SPDX-License-Identifier: AGPL-3.0-only
# Build from repo root. Static files, served by an unprivileged nginx.
FROM node:22.23.1-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/console/package.json apps/console/
RUN pnpm install --frozen-lockfile --filter @katip/console
COPY apps/console apps/console
RUN pnpm --filter @katip/console build

FROM nginxinc/nginx-unprivileged:1.29.3-alpine
COPY apps/console/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
