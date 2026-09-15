# OpenSuite API image — build from repo root:
#   docker build -t opensuite-api .
# Atlas/Dokploy: docker-compose.atlas.yml (API only; external DB + MinIO).
#
# Engine: default in-repo stub (API soft-boots without DOCX).
# After publishing @opensuite/engine to npm, rebuild with:
#   --build-arg USE_PUBLISHED_ENGINE=true

# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG USE_PUBLISHED_ENGINE=false
ENV USE_PUBLISHED_ENGINE=${USE_PUBLISHED_ENGINE}
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
COPY vendor/opensuite-engine vendor/opensuite-engine

# Drop sibling-repo pnpm.overrides; resolve engine from npm or the in-repo stub.
RUN node -e "\
const fs=require('fs');\
const usePublished=process.env.USE_PUBLISHED_ENGINE==='true';\
const root=JSON.parse(fs.readFileSync('package.json','utf8'));\
if(root.pnpm&&root.pnpm.overrides){\
  delete root.pnpm.overrides['@opensuite/engine'];\
  if(!Object.keys(root.pnpm.overrides).length) delete root.pnpm.overrides;\
  if(root.pnpm&&!Object.keys(root.pnpm).length) delete root.pnpm;\
}\
fs.writeFileSync('package.json',JSON.stringify(root,null,2)+'\\n');\
const eng=JSON.parse(fs.readFileSync('packages/engine-client/package.json','utf8'));\
eng.optionalDependencies=eng.optionalDependencies||{};\
eng.optionalDependencies['@opensuite/engine']=usePublished?'^0.1.0':'file:../../vendor/opensuite-engine';\
fs.writeFileSync('packages/engine-client/package.json',JSON.stringify(eng,null,2)+'\\n');\
console.log('engine dep ->',eng.optionalDependencies['@opensuite/engine']);\
"

RUN pnpm install --no-frozen-lockfile --filter @opensuite/api...

COPY packages ./packages
COPY apps/api ./apps/api
COPY deploy ./deploy
COPY vendor/opensuite-engine vendor/opensuite-engine

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
