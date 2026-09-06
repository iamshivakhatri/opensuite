# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation + Casual Docs DOCX surface v1.
* Theme architecture (`themePreference` / `resolvedTheme` / Casual isolation).
* **Production DOCX agent runtime is engine-backed (no mock DOCX content).**
* **Agent `document.replace_text` persists immutable N+1 and advances run DocumentRef.**
* Agent chat: durable tool progress (✓ + Thinking), GFM table rendering, compact API request logs.

## Just Completed

* Injected `DocumentMutationExecutor` → `applyReplaceText` (one engine execute + append)
* Tool success = persistence success; run advances primaryDocument N → N+1
* SSE `document.version.advanced` → editor reloads via existing version bump path
* Same-run read-after-write + failure/conflict unit tests

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / semantic-mutation source of truth; app owns versions/storage.
* DOCX overview/tables inspect still unsupported until Rust typed contracts exist — latency today is mostly LLM round-trips for find/inspect probes.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** (agent-core 59, engine-client 20, api 85+17 skip, web 11) |
| `pnpm build` | **Pass** |
| `git diff --check` | **Pass** |
| DB integration: agent replace → N+1 read-after-write | **Pass** |

## Intentionally Deferred

* Broad DOCX inspect (overview/headings/tables) in Rust — biggest latency win
* PPTX/XLSX engine runtimes; HTTP mutation endpoint
* More engine mutations; review/revert UI; automatic rebase

## Recommended Next Step

Broad typed DOCX inspect (tables/overview) in opensuite-engine.
