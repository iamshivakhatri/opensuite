# OpenSuite API image — build from repo root:
#   docker build -t opensuite-api .
# Atlas/Dokploy: docker-compose.atlas.yml (API only; external DB + MinIO).
#
# Native engine: @opensuitehq/engine@0.1.1 from npm (glibc platforms only).
# Base image is Debian bookworm (glibc) — Alpine/musl is incompatible.

# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.25.0 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json .npmrc tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/agent-core-v2/package.json packages/agent-core-v2/
COPY packages/agent-core-v3/package.json packages/agent-core-v3/
COPY packages/engine-client/package.json packages/engine-client/

RUN pnpm install --frozen-lockfile --filter @opensuite/api...

COPY packages ./packages
COPY apps/api ./apps/api
COPY deploy ./deploy

RUN pnpm --filter @opensuite/api... build

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@11.25.0 --activate \
  && groupadd --system --gid 1001 opensuite \
  && useradd --system --uid 1001 --gid opensuite --create-home opensuite
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY --from=build --chown=opensuite:opensuite /app /app
RUN chmod +x /app/deploy/docker-entrypoint.sh

USER opensuite
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
