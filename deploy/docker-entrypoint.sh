#!/bin/sh
set -eu

cd /app

# Prefer a real require() over path heuristics — pnpm stores the .node under
# node_modules/.pnpm/@opensuitehq+engine-linux-*, not next to index.js.
if node --input-type=module -e '
import { createRequire } from "node:module";
const require = createRequire("/app/packages/engine-client/dist/docx-engine-binding.js");
const eng = require("@opensuitehq/engine");
const caps = eng.getDocxCapabilities();
if (!caps?.ok) throw new Error("capabilities not ok");
console.log("[opensuite] engine ok version=" + caps.engineVersion);
' 2>/tmp/opensuite-engine-check.err; then
  :
else
  echo "[opensuite] WARN: @opensuitehq/engine native binding unavailable — DOCX disabled." >&2
  echo "[opensuite] Supported: darwin-arm64/x64, linux-*-gnu, win32-x64-msvc (glibc; no Alpine/musl)." >&2
  sed 's/^/[opensuite] engine: /' /tmp/opensuite-engine-check.err >&2 || true
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[opensuite] ERROR: DATABASE_URL is not set — cannot migrate." >&2
  exit 1
fi

echo "[opensuite] running database migrations…"
if ! pnpm --filter @opensuite/db db:migrate; then
  echo "[opensuite] ERROR: migrations failed (see cause above)." >&2
  echo "[opensuite] Check DATABASE_URL reachability from this container and that migration SQL files are present in the image." >&2
  exit 1
fi

echo "[opensuite] starting API on ${HOST:-0.0.0.0}:${PORT:-3000}"
exec node apps/api/dist/server.js
