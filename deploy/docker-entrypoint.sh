#!/bin/sh
set -eu

ENGINE_DIR="packages/engine-client/node_modules/@opensuitehq/engine"
if [ ! -f "$ENGINE_DIR/package.json" ]; then
  echo "[opensuite] WARN: @opensuitehq/engine not installed — DOCX features disabled." >&2
  echo "[opensuite] Install @opensuitehq/engine@0.1.1 (see docs/deploy.md)." >&2
elif ! ls "$ENGINE_DIR"/opensuite_node.*.node >/dev/null 2>&1 \
  && ! ls "$ENGINE_DIR"/node_modules/@opensuitehq/engine-*/opensuite_node.*.node >/dev/null 2>&1; then
  echo "[opensuite] WARN: @opensuitehq/engine has no native .node binary — DOCX features disabled." >&2
  echo "[opensuite] Supported: darwin-arm64/x64, linux-*-gnu, win32-x64-msvc (no Alpine/musl)." >&2
fi

echo "[opensuite] running database migrations…"
pnpm --filter @opensuite/db db:migrate

echo "[opensuite] starting API on ${HOST:-0.0.0.0}:${PORT:-3000}"
exec node apps/api/dist/server.js
