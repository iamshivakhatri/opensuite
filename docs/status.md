# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation (exact content GET, append, human save, `baseVersionId` concurrency, agent run provenance).
* **Casual Docs DOCX surface v1** (host-owned):
  * `@casualoffice/docs` `DocxEditor` with `documentBuffer` / `export()` / `onDirtyChange`
  * Load exact `latestVersion.id` bytes via `fetchDocumentVersionContent`
  * Explicit Save + ⌘/Ctrl+S → `saveDocumentVersion` (no autosave)
  * Dirty / conflict / newer-version banners; discard confirm on tab close / navigate
  * PPTX/XLSX remain placeholders
  * See `docs/docx_roundtrip.md`

## Just Completed

* Interactive DOCX editing on the immutable version contract.

## Current Decisions

* Soft-delete only; panel prefs browser-local.
* Latest = max `version_number`; versions immutable.
* Optimistic concurrency: `baseVersionId` + row lock + unique version number.
* OpenSuite owns persistence; Casual is render/edit/export only (no Casual AI/collab/FileSource).

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `pnpm build` | **Pass** |

## Intentionally Deferred

* Casual Sheets/Slides, autosave, agent selection context, agent artifact persistence
* Diff/review/revert, merge/rebase, version-history UI, collaboration
* Content search, permanent delete, Rust engine mutation

## Recommended Next Step

Manual DOCX QA with real Word files (round-trip + conflict), then Casual Sheets when ready.
