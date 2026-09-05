# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + `/app/search` + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tab strip, resizable/collapsible panels (local prefs), breadcrumbs, ⌘W/⌘O, toasts, shared empty/loading/error states.

## Just Completed

* Workspace DnD + multi-file Office upload (shared `uploadOfficeFiles`).
* Document tabs: active/close/hover, ⌘W, neighbor selection, scroll overflow.
* Explorer + Agent: drag-resize, collapse, `localStorage` prefs.
* Toasts for upload/rename/star/trash/restore/workspace CRUD.
* Header breadcrumbs: Workspaces / Workspace / Document.

## Current Decisions

* No Office content search / FTS yet.
* Soft-delete only; mock agent mutations in-memory.
* Panel prefs browser-local only (no DB).

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `pnpm build` | **Pass** |
| Office content search / rendering | **Not implemented** |

## Intentionally Deferred

* Content search, semantic search, permanent delete
* Real Office mutation / Rust engine / folders / sharing
* Workspace-scoped agent / IDE-grade tab manager

## Recommended Next Step

Manual QA of desktop polish (DnD, panels, shortcuts), then engine-backed DocumentRuntime when ready.
