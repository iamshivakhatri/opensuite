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
* **Real DOCX inspect: overview / headings / paragraphs / tables / context** (paged, Rust-authoritative).
* Table inspect exposes opaque artifact-local handles; mutations accept handle or semantic selectors.
* **Agent DOCX mutations persist immutable N+1 and advance run DocumentRef.**
* Agent chat: Cursor-style work toggle (“Thought for Xs”), single wall-clock timer, Stop square in composer.
* Optional semantic `occurrence`: omit / null / "" / **0 → omitted**; explicit values stay **1-based**.
* **Capability-driven tool discovery** at run bootstrap (global: which functions exist).
* **Artifact affordances** on inspect (format-neutral; TS does not recompute editability).
* **Version-bound handle enforcement:** run-local `ArtifactHandleRegistry` (handle → inspected versionId).
  Inspect registers opaque handles; handle-based mutations validate before Rust (`STALE_HANDLE` / `UNKNOWN_HANDLE`).
  Model still sees plain handle strings — no version UUIDs in schemas.

## Just Completed

* Milestone: enforce version-bound artifact handles (run-local registry; stale rejected before engine).
* Prior: format-neutral artifact affordances; capability-driven tool discovery.

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / affordance / semantic-mutation source of truth; app owns versions + handle lifetime.
* Structural handles are opaque and version-bound; re-inspect after N→N+1 before reuse.
* Global capabilities ≠ target affordances ≠ handle lifetime (three distinct layers).
* Affordance absence means “not provided” — never invent supported/unsupported in TS.
* Real DOCX never falls back to mock inspect semantics.
* Capability advertised ≠ every table structure is safe.
* `pnpm dev:api` rebuilds agent-core first — restart after agent-core changes.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (101) |
| `pnpm --filter @opensuite/api test` | **Pass** (88+17 skip) |
| `pnpm --filter @opensuite/agent-core typecheck` | **Pass** |
| `pnpm --filter @opensuite/api typecheck` | **Pass** |

## Intentionally Deferred

* Structured Rust diagnostics; engine tool manifest
* Affordance-driven recovery policies / reason-specific fallbacks
* Affordances on paragraphs, pictures, slides, sheets, ranges
* Separate affordance registry (handles becoming stale is enough for now)
* Engine: harden `insert_table_column` verify for empty `headerCells`
* Delete rows/columns / create_table / multi-column insert
* PPTX/XLSX engine runtimes; HTTP mutation endpoint

## Recommended Next Step

Milestone 4 focus TBD: structured diagnostics, richer handle-first UX, or next engine mutation.
