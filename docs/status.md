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
* **Real DOCX inspect: overview / headings / paragraphs / tables / body_blocks / context** (paged, Rust-authoritative).
* Table inspect exposes opaque artifact-local handles; mutations accept handle or semantic selectors.
* **Blank DOCX creation:** API → engine-client `createBlankDocx` → Rust bytes → storage + Version 1 (`source: user`).
* **Workspace agent chat** + **`workspace.create_blank_docx`**.
* **Paragraph authoring (capability-gated):** insert_paragraph(s), delete_paragraph, set_paragraph_style/formatting, set_text_formatting.
* **Full table lifecycle (capability-gated):** create_table (atomic matrix + body placement), set_table_cells_text, insert_table_rows/column, delete_table_row/column, delete_table.
* **Agent DOCX mutations persist immutable N+1** + SSE `document.version.advanced`.
* Capability-driven tool discovery; version-bound ArtifactHandleRegistry; structured diagnostics passthrough; affordances transport-only.

## Just Completed

* Milestone 6B: wired create_table / delete_table / delete_table_row / delete_table_column through engine-client → runtime → DocumentMutationExecutor → agent tools.
* Prefer one populated `create_table` when initial matrix is known (no placeholder table).

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / affordance / semantic-mutation / diagnostic source of truth; app owns versions + handle lifetime.
* Structural handles opaque + version-bound; re-inspect after N→N+1.
* Affordance/diagnostic absence ≠ invent in TS.
* Real DOCX never falls back to mock inspect.
* `pnpm dev:api` rebuilds agent-core first — restart after agent-core / engine-client / native binary changes.
* N-API paragraph formatting still alignment + spacing only.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (127) |
| `pnpm --filter @opensuite/engine-client test` | **Pass** (60) |
| `pnpm --filter @opensuite/api test` | **Pass** (95+17 skip) |
| `pnpm --filter @opensuite/web test` | **Pass** (16) |
| typechecks (agent-core, engine-client, api, web) | **Pass** |
| Native create_table capability smoke | **Pass** |

## Intentionally Deferred

* Affordance-driven recovery policies / reason-specific fallbacks
* Engine tool manifest; separate affordance registry
* Engine: harden `insert_table_column` verify for empty `headerCells`
* Table styling / merged cells / nested tables / batch row-column delete
* Lists / images / hyperlinks
* Full paragraph-formatting N-API (indent, keepWithNext, …)
* PPTX/XLSX engine runtimes; HTTP mutation endpoint
* Legacy `insert_paragraph_after` model tool

## Recommended Next Step

Restart API (`pnpm dev:api`) with refreshed `@opensuite/engine` binary, then browser-accept blank project tracker lifecycle + paragraph/table composition.
