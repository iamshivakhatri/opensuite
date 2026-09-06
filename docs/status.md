# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation (exact content GET, append, human save, `baseVersionId` concurrency, agent run provenance).
* **Casual Docs DOCX surface v1** (host-owned load/save; see `docs/docx_roundtrip.md`).
* Theme architecture (`themePreference` / `resolvedTheme` / Casual isolation).
* **Engine adapter + mutation persistence (ReplaceText only):**
  * `OpenSuiteEngineAdapter` → verified `artifactBytes` (no DB/storage writes)
  * `createOwnedDocumentArtifactLoader` loads exact version bytes via DocumentService
  * `createDocumentMutationService.applyReplaceText` persists N→N+1 via `appendDocumentVersion`
  * Atomic concurrency: document row `FOR UPDATE` + `latest.id === baseVersionId`
  * Failed engine runs never create versions; stale outputs return `VERSION_CONFLICT` + best-effort object cleanup
  * `MockDocumentRuntime` remains API/agent default (real inspect/find not wired)

## Just Completed

* Storage-backed artifact loader + document mutation persistence service
* Unit + (optional DB) integration tests for loader/mutation/concurrency

## Current Decisions

* Soft-delete only; panel prefs browser-local.
* Latest = max `version_number`; versions immutable (no `current_version_id` column).
* Optimistic concurrency: `baseVersionId` + row lock + unique version number.
* OpenSuite owns persistence + theme; engine owns semantic mutation/validity.
* Engine N-API is a hidden transport, not the permanent universal contract.
* Do not switch production agent runtime to engine until inspect/find are real.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `pnpm build` | **Pass** |
| Mutation DB integration (`RUN_DB_INTEGRATION_TESTS=true`) | **Pass** |

## Intentionally Deferred

* Wire `OpenSuiteEngineAdapter` as API agent default
* Engine-backed inspect/find; PPTX/XLSX engine ops
* Agent-run auto-call of `applyReplaceText` / HTTP mutation endpoint
* Casual Sheets/Slides, autosave, diff/review/revert UI

## Recommended Next Step

Engine-backed inspect/find, then compose a real DocumentRuntime for agent execution.
