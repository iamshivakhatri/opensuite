#!/bin/sh
set -eu

ENGINE_DIR="packages/engine-client/node_modules/@opensuite/engine"
if [ ! -f "$ENGINE_DIR/package.json" ]; then
  echo "[opensuite] ERROR: @opensuite/engine missing in the image." >&2
  echo "[opensuite] Rebuild with ENGINE_GIT_URL=<opensuite-engine git URL>." >&2
  exit 1
fi

echo "[opensuite] running database migrations…"
pnpm --filter @opensuite/db db:migrate

echo "[opensuite] starting API on ${HOST:-0.0.0.0}:${PORT:-3000}"
exec node apps/api/dist/server.js
