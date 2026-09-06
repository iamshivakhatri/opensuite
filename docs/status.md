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
* **Agent DOCX mutations persist immutable N+1 and advance run DocumentRef:**
  `replace_text`, `set_table_cells_text`, `insert_table_rows`, `insert_table_column`.
* Agent chat: Cursor-style work toggle (“Thought for Xs”), single wall-clock timer, Stop square in composer.

## Just Completed

* Wired semantic table mutations end-to-end (binding → adapter → shared mutation service → AgentTools → DocumentRef + SSE).

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / semantic-mutation source of truth; app owns versions/storage.
* Inspect occurrence/order is version-local — never durable semantic identity.
* Real DOCX never falls back to mock inspect semantics.
* Capability advertised ≠ every table structure is safe (merged/complex → `UNSUPPORTED_OPERATION`).
* Separate tool calls = separate immutable versions; within one engine op, updates are atomic.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** (agent-core 66, engine-client 27, api 88+17 skip, web 14, db 14+1 skip) |
| `pnpm build` | **Pass** |
| `git diff --check` | **Pass** |
| Native smoke table mutations | **Pass** (inspect → rows → cells → column) |

## Intentionally Deferred

* Delete rows/columns / create_table / multi-column insert
* Persist full per-turn timeline in DB
* PPTX/XLSX engine runtimes; HTTP mutation endpoint
* Review/revert UI; automatic rebase; app-level multi-tool transactions

## Recommended Next Step

Real browser smoke on an uploaded Name/Role DOCX: inspect → insert rows → set cells → insert column; confirm editor reload.
