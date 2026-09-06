# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* `/app` home upload dropzone → pick existing workspace or create new.
* **Immutable document version foundation** (no Casual editor yet):
  * `appendDocumentVersion` — shared append path (`user` | `agent` | `system`)
  * `GET /api/documents/:id/versions/:versionId/content` — exact version bytes
  * `POST /api/documents/:id/versions` — human save (`baseVersionId` + file → `source=user`)
  * Stale `baseVersionId` → `409 VERSION_CONFLICT`
  * `agent_run.base_document_version_id` provenance for document-scoped runs
  * Public DTOs never expose `storageKey`
  * Web helpers: `fetchDocumentVersionContent`, `saveDocumentVersion`

## Just Completed

* Human editing / version persistence contract (API + schema + frontend primitives).

## Current Decisions

* Soft-delete only (no permanent delete yet).
* Panel prefs browser-local only.
* Latest version = highest `version_number`; versions never mutated.
* Optimistic concurrency via `baseVersionId` + `SELECT … FOR UPDATE` + unique `(document_id, version_number)`.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `pnpm build` | **Pass** |
| `RUN_DB_INTEGRATION_TESTS=true` (api) | **Pass** (88/88) |

## Intentionally Deferred

* Casual Docs/Sheets/Slides, autosave, editor UI, dirty/Cmd+S
* Agent artifact persistence / `resultVersionId`
* Diff/review/revert, merge/rebase, locks, version-history UI
* Content search, permanent delete, Office rendering, engine mutation

## Recommended Next Step

Wire Casual Docs against `fetchDocumentVersionContent` + `saveDocumentVersion` (explicit save only).
