# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation (exact content GET, append, human save, `baseVersionId` concurrency, agent run provenance).
* **Casual Docs DOCX surface v1** (host-owned load/save; see `docs/docx_roundtrip.md`).
* **Theme architecture:**
  * `themePreference` (`light|dark|system`) persisted in `opensuite.theme`
  * `resolvedTheme` (`light|dark`) applied only via `data-opensuite-theme` on `<html>`
  * Casual Docs consumes theme: forced `casual-editor:color-theme` + mirrored `data-theme` (never `auto`)
  * DOCX page stays white paper; shell/chrome follow OpenSuite tokens
* **First real engine adapter (ReplaceText only):**
  * `OpenSuiteEngineAdapter` in `packages/engine-client` implements `DocumentRuntime`
  * Path: AgentTool → DocumentRuntime → adapter → N-API `executeDocxReplaceText` → verified bytes
  * Returns in-memory `artifactBytes` on success; no DB version append inside the adapter
  * `MockDocumentRuntime` remains default for API/agent-core tests

## Just Completed

* `OpenSuiteEngineAdapter` + local `@opensuite/engine` optionalDependency integration
* Adapter unit tests (fake binding) + N-API smoke test

## Current Decisions

* Soft-delete only; panel prefs browser-local.
* Latest = max `version_number`; versions immutable.
* Optimistic concurrency: `baseVersionId` + row lock + unique version number.
* OpenSuite owns persistence + theme; Casual is render/edit/export only.
* Do **not** share `data-theme` with OpenSuite tokens — Casual mutates that attribute.
* Engine N-API is a hidden transport, not the permanent universal contract.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** (incl. engine-client adapter + N-API smoke) |
| `pnpm build` | **Pass** |
| Smoke artifact | `/private/tmp/opensuite-app-engine-adapter-output.docx` |

## Intentionally Deferred

* Wire adapter into `apps/api` default runtime (still MockDocumentRuntime)
* Persist agent mutation `artifactBytes` as a new document version
* Engine-backed inspect/find; PPTX/XLSX engine ops
* Casual Sheets/Slides, autosave, agent selection context
* Diff/review/revert, merge/rebase, version-history UI, collaboration

## Known Theme Limitations

* Casual still writes `data-app="docs"` / `data-theme` on `<html>`; OpenSuite ignores those for its tokens.
* Theme switch while DOCX is open updates Casual via DOM/`localStorage` without remounting (dirty state preserved).

## Recommended Next Step

Inject a storage-backed `DocumentArtifactLoader` in `apps/api` and optionally swap DOCX mutate runs onto `OpenSuiteEngineAdapter` while keeping mock inspect/find (or a composed runtime).
