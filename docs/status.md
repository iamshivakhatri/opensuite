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
* Table inspect exposes opaque artifact-local handles (table/column/row/cell); mutations accept handle or semantic selectors.
* **Agent DOCX mutations persist immutable N+1 and advance run DocumentRef:**
  `replace_text`, `set_table_cells_text`, `insert_table_rows`, `insert_table_column`.
* Agent chat: Cursor-style work toggle (“Thought for Xs”), single wall-clock timer, Stop square in composer.
* Optional semantic `occurrence`: omit / null / "" / **0 → omitted**; explicit values stay **1-based**.
* **Document tools are declarative descriptors** under `packages/agent-core/src/document-tools/`.
* **Capability-driven tool discovery at run bootstrap** (global: which functions exist).
* **Artifact affordances on inspect** (format-neutral `DocumentAffordance`): engine → binding → adapter →
  `document.inspect` → model. DOCX tables/cells are the first populated objects; TS does not recompute editability.

## Just Completed

* Milestone: format-neutral artifact affordances on inspect (DOCX table/cell transport).
* Prior: capability-driven document tool discovery.

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / affordance / semantic-mutation source of truth; app owns versions/storage.
* Global capabilities ≠ target affordances; both layers stay distinct.
* Affordance absence means “not provided” — never invent supported/unsupported in TS.
* Inspect occurrence/order is version-local — never durable semantic identity.
* Structural table handles are opaque, artifact-local, short-lived — never persisted; re-inspect after version-changing edits.
* Real DOCX never falls back to mock inspect semantics.
* Capability advertised ≠ every table structure is safe (merged/complex → `UNSUPPORTED_OPERATION`).
* Separate tool calls = separate immutable versions; within one engine op, updates are atomic.
* `pnpm dev:api` rebuilds agent-core first — restart after agent-core changes.
* Discovery failure → `CAPABILITY_DISCOVERY_FAILED` (never expose all document tools).

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (90) |
| `pnpm --filter @opensuite/engine-client test` | **Pass** (37) |
| `pnpm --filter @opensuite/api test` | **Pass** (88+17 skip) |
| Google Docs fixture native affordances | **Pass** (mixed Name/Year/OpenSuite/2026) |

## Intentionally Deferred

* Stale-handle enforcement; structured diagnostics; engine tool manifest
* Affordance-driven agent recovery policies / reason-specific fallbacks
* Affordances on paragraphs, pictures, slides, sheets, ranges, etc.
* Engine: harden `insert_table_column` verify for empty `headerCells`
* Delete rows/columns / create_table / multi-column insert
* PPTX/XLSX engine runtimes; HTTP mutation endpoint
* Review/revert UI; automatic rebase; app-level multi-tool transactions

## Recommended Next Step

Milestone 3 / structural-handle UX: richer handle-first browser flow on real DOCX, or stale-handle enforcement — pick one focused concern.
