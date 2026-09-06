# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation + Casual Docs DOCX surface v1.
* Theme architecture (`themePreference` / `resolvedTheme` / Casual isolation).
* **Real DOCX DocumentRuntime (engine-backed reads + ReplaceText):**
  * `DocxEngineBinding`: `getDocxCapabilities` / `findDocxText` / `inspectDocx` / `executeDocxReplaceText`
  * Caps from Rust `RuntimeCapabilities` (mapped to `document.find|inspect|mutate`)
  * Exact-version find (`mode: text`); `semantic` → honest `UNSUPPORTED_OPERATION`
  * Inspect `focus.kind=context` only; broad focuses → `UNSUPPORTED_OPERATION` (no mock fallback)
  * Mutation persistence: N → verified bytes → N+1 via `appendDocumentVersion`
  * `MockDocumentRuntime` remains API/agent **default** (PPTX/XLSX still mock-only)

## Just Completed

* Wired real DOCX capabilities/find/inspect-context into `OpenSuiteEngineAdapter`
* Lifecycle smoke: caps → find → inspect → replace → read output version

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / semantic-mutation source of truth; app owns versions/storage.
* No mock semantic fallback inside real DOCX adapter.
* Do not flip global API agent runtime until PPTX/XLSX routing is deliberate.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** (engine-client 20; agent-core 52; api 84+16 skip without DB / 100 with DB) |
| `pnpm build` | **Pass** |
| `git diff --check` | Clean |
| N-API smoke (caps→find→inspect→replace→read) | **Pass** |
| Mutation DB integration (`RUN_DB_INTEGRATION_TESTS=true`) | **Pass** |

## Intentionally Deferred

* API default runtime switch to OpenSuiteEngineAdapter (format routing needed)
* Broad DOCX inspect (overview/headings/tables) until Rust typed contracts exist
* More engine mutations; agent auto-persist wiring / HTTP mutation endpoint

## Recommended Next Step

Format-aware runtime selection in `apps/api` (DOCX→engine, PPTX/XLSX→mock), then production agent default.
