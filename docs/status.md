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
* **Document tools are declarative descriptors** under `packages/agent-core/src/document-tools/`
  (`defineDocumentTool`, shared selectors/schemas, shared `executePersistedMutation`).

## Just Completed

* Refactor: document tool boundary — shared define/capability/mutation plumbing; no new caps; behavior preserved.
* Prior: Dev API plain logs; stop abandoned-run GET flood; `insert_table_column` empty `headerCells` app guard; version-local table handles.

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / semantic-mutation source of truth; app owns versions/storage.
* Inspect occurrence/order is version-local — never durable semantic identity.
* Structural table handles are opaque, artifact-local, short-lived — never persisted; re-inspect after version-changing edits.
* Semantic selectors = human-readable convenience; handles = exact inspected-artifact targeting (blank/duplicate rows).
* Real DOCX never falls back to mock inspect semantics.
* Capability advertised ≠ every table structure is safe (merged/complex → `UNSUPPORTED_OPERATION`).
* Separate tool calls = separate immutable versions; within one engine op, updates are atomic.
* `pnpm dev:api` rebuilds agent-core first — restart after agent-core changes.
* TypeScript validates request shape/routing only — no blank-row / one-paragraph / OOXML safety rules in app.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (77) |
| `pnpm --filter @opensuite/engine-client test` | **Pass** (34) |
| `pnpm --filter @opensuite/api test` | **Pass** (88+17 skip) |
| `pnpm --filter @opensuite/web test` | **Pass** (15) |
| `pnpm --filter @opensuite/agent-core typecheck` | **Pass** |
| `git diff --check` | **Pass** |

## Intentionally Deferred

* Structural-handle browser scenario / richer handle-first UX milestone (next)
* Engine: harden `insert_table_column` verify so empty `headerCells` returns a structured error instead of panicking
* Delete rows/columns / create_table / multi-column insert
* Persist full per-turn timeline in DB
* PPTX/XLSX engine runtimes; HTTP mutation endpoint
* Review/revert UI; automatic rebase; app-level multi-tool transactions

## Recommended Next Step

Structural-handle milestone: browser/agent flow for exact artifact-local table targeting on real DOCX (no semantic mock fallback).
