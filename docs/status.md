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
* **Blank DOCX creation:** API → engine-client `createBlankDocx` → Rust bytes → storage + Version 1 (`source: user`). Not a DocumentRuntime mutation.
* **New Document** UI (palette + explorer) creates blank DOCX and opens the editor (no upload).
* **Workspace agent chat** (not document-forced): `@` tag / drag files from explorer; optional open file used as primary when untagged.
* **`workspace.create_blank_docx`** agent tool creates blank DOCX and promotes it as run primary (re-discovers document tools).
* **`document.insert_paragraph`** capability-gated; placements start|end|before|after body-block handles.
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

* Perplexity-style agent progress: compact “Finished N steps · Xs ›”, grouped repeats (not 13× Inserted paragraph).
* Agent guidance: human multi-sentence paragraphs; fewer insert_paragraph calls (app/model, not Rust).
* Prior: Thought stay-visible; editor conflict/dirty race; header flicker; workspace chat + blank tool.

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
| `pnpm --filter @opensuite/agent-core test` | **Pass** (111) |
| `pnpm --filter @opensuite/engine-client test` | **Pass** (50) |
| `pnpm --filter @opensuite/api test` | **Pass** (95+17 skip) |
| `pnpm --filter @opensuite/web test` | **Pass** (15) |
| `pnpm --filter @opensuite/{agent-core,engine-client,api,web} typecheck` | **Pass** |
| Native blank + body_blocks + insert_paragraph | **Pass** |

## Intentionally Deferred

* Affordance-driven recovery policies / reason-specific fallbacks
* Engine tool manifest
* Affordances on paragraphs, pictures, slides, sheets, ranges
* Separate affordance registry (handles becoming stale is enough for now)
* Engine: harden `insert_table_column` verify for empty `headerCells`
* Delete rows/columns / create_table / multi-column insert / lists / images
* App wiring for paragraph style/format/delete (Rust caps exist; **no N-API yet**):
  `set_paragraph_style`, `set_paragraph_formatting`, `set_text_formatting`,
  `delete_paragraph`, `insert_paragraph_after`
* PPTX/XLSX engine runtimes; HTTP mutation endpoint

## Recommended Next Step

Restart API (`pnpm dev:api`) and verify: workspace chat without open file, `@` tag / drag file, “create a blank doc” via agent.
