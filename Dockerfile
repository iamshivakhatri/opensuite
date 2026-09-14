# OpenSuite API image — build from repo root:
#   docker build -t opensuite-api .
# Dokploy: point the compose file at this Dockerfile (context = repo root).
#
# Native DOCX engine: set build-arg ENGINE_GIT_URL to the opensuite-engine git
# URL (HTTPS). Without it, the image builds but the API will not start until
# @opensuite/engine is present (see docs/deploy.md).

# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

# ── optional: build linux N-API engine from a separate git repo ───────────────
FROM node:${NODE_VERSION}-bookworm AS engine
ARG ENGINE_GIT_URL=
ARG ENGINE_GIT_REF=main
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential ca-certificates curl git python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /src
RUN --mount=type=secret,id=engine_git_token,required=false \
  if [ -z "$ENGINE_GIT_URL" ]; then \
    mkdir -p /out && echo "ENGINE_GIT_URL unset — skipping engine build" > /out/SKIP; \
  else \
    TOKEN=""; \
    if [ -f /run/secrets/engine_git_token ]; then TOKEN="$(cat /run/secrets/engine_git_token)"; fi; \
    CLONE_URL="$ENGINE_GIT_URL"; \
    if [ -n "$TOKEN" ]; then \
      CLONE_URL="$(echo "$ENGINE_GIT_URL" | sed "s#https://#https://x-access-token:${TOKEN}@#")"; \
    fi; \
    git clone --depth 1 --branch "$ENGINE_GIT_REF" "$CLONE_URL" . \
    && cd crates/opensuite-node \
    && npm ci \
    && npm run build \
    && EXPECTED="opensuite_node.$(node -p 'process.platform')-$(node -p 'process.arch').node" \
    && if [ ! -f "$EXPECTED" ]; then \
         BUILT="$(ls opensuite_node.*.node | head -n 1)"; \
         cp "$BUILT" "$EXPECTED"; \
       fi \
    && mkdir -p /out \
    && cp -a package.json index.js index.d.ts opensuite_node.*.node /out/; \
  fi

# ── install + build API workspace packages ───────────────────────────────────
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
COPY packages/agent-core/package.json packages/agent-core/
COPY packages/engine-client/package.json packages/engine-client/

# Sibling-repo `link:` optionalDependency is unavailable in Docker — drop it.
RUN node -e "const fs=require('fs'); const p='packages/engine-client/package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); delete j.optionalDependencies; fs.writeFileSync(p, JSON.stringify(j,null,2)+'\\n');"

RUN pnpm install --frozen-lockfile --filter @opensuite/api...

COPY packages ./packages
COPY apps/api ./apps/api
COPY deploy ./deploy

RUN pnpm --filter @opensuite/api... build

# Drop the engine package into a place Node can require from engine-client.
COPY --from=engine /out /tmp/engine-out
RUN if [ ! -f /tmp/engine-out/SKIP ]; then \
      mkdir -p packages/engine-client/node_modules/@opensuite/engine \
      && cp -a /tmp/engine-out/. packages/engine-client/node_modules/@opensuite/engine/; \
    fi

# ── runtime ──────────────────────────────────────────────────────────────────
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
