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
* **Structured engine diagnostics** pass through end-to-end:
  optional `reasonCode` / `operation` / `targetHandle` on runtime `Diagnostic`
  → AgentTool failure → model tool result → `agent_step.output`.
  Same reason id appears on affordance `reason` and mutation `reasonCode` (e.g. `MULTIPLE_PARAGRAPHS`).
  Never derive structured fields from English `message`.

## Just Completed

* Milestone 4B: wire structured engine diagnostics into the agent (transport + minimal prompt).
* Prior: enforce version-bound artifact handles; format-neutral affordances; capability-driven discovery.

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / affordance / semantic-mutation / diagnostic source of truth; app owns versions + handle lifetime.
* Structural handles are opaque and version-bound; re-inspect after N→N+1 before reuse.
* Global capabilities ≠ target affordances ≠ handle lifetime ≠ structured execution diagnostics (four distinct layers).
* Affordance absence means “not provided” — never invent supported/unsupported in TS.
* Diagnostic absence of `reasonCode` means unavailable — never invent from `message`.
* Real DOCX never falls back to mock inspect semantics.
* Capability advertised ≠ every table structure is safe.
* `pnpm dev:api` rebuilds agent-core first — restart after agent-core changes.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (106) |
| `pnpm --filter @opensuite/engine-client test` | **Pass** (42) |
| `pnpm --filter @opensuite/api test` | **Pass** (91+17 skip) |
| `pnpm --filter @opensuite/agent-core typecheck` | **Pass** |
| `pnpm --filter @opensuite/engine-client typecheck` | **Pass** |
| `pnpm --filter @opensuite/api typecheck` | **Pass** |
| Native google-docs fixture structured diagnostic | **Pass** |

## Intentionally Deferred

* Affordance-driven recovery policies / reason-specific fallbacks
* Engine tool manifest
* Affordances on paragraphs, pictures, slides, sheets, ranges
* Separate affordance registry (handles becoming stale is enough for now)
* Engine: harden `insert_table_column` verify for empty `headerCells`
* Delete rows/columns / create_table / multi-column insert
* PPTX/XLSX engine runtimes; HTTP mutation endpoint

## Recommended Next Step

Affordance-aware recovery policies (still deferred), richer handle-first UX, or next engine mutation.
