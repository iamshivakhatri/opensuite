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
* Agent chat: durable tool progress (✓ + Thinking), GFM table rendering, compact API request logs.

## Just Completed

* Progress no longer flickers back to bare Thinking after every fast tool
* AgentMarkdown renders pipe tables; API request logs are one-line summaries
* System prompt prefers 1–2 DOCX find calls (cuts multi-round latency)

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / semantic-mutation source of truth; app owns versions/storage.
* DOCX overview/tables inspect still unsupported until Rust typed contracts exist — latency today is mostly LLM round-trips for find/inspect probes.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/web test` | **Pass** |
| `pnpm --filter @opensuite/api typecheck` | **Pass** |
| `pnpm --filter @opensuite/agent-core test` | **Pass** (52) |

## Intentionally Deferred

* Broad DOCX inspect (overview/headings/tables) in Rust — biggest latency win
* PPTX/XLSX engine runtimes; agent auto-persist of mutation artifactBytes
* More engine mutations; HTTP mutation endpoint

## Recommended Next Step

Broad typed DOCX inspect (tables/overview) in opensuite-engine.
