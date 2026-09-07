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
* **Paragraph authoring (capability-gated):** `insert_paragraph`, `insert_paragraphs` (atomic batch), `delete_paragraph`, `set_paragraph_style`, `set_paragraph_formatting`, `set_text_formatting`.
  Placements start|end|before|after body-block handles; style/format/delete use semantic text targets.
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

* Milestone 5C-B: wired native paragraph authoring through engine-client → DocumentRuntime → DocumentMutationExecutor → agent tools (batch insert, style, paragraph/text formatting, delete).
* Prefer `insert_paragraphs` for multi-paragraph creation (one immutable version).
* Prior: Perplexity-style agent progress; Thought stay-visible; workspace chat + blank tool.

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
* N-API paragraph formatting patch currently exposes alignment + spacingBefore/AfterTwips only (indent/keep* remain engine-protocol / deferred N-API).

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (120) |
| `pnpm --filter @opensuite/engine-client test` | **Pass** (55, native included) |
| `pnpm --filter @opensuite/api test` | **Pass** (95+17 skip) |
| `pnpm --filter @opensuite/web test` | **Pass** (16) |
| `pnpm --filter @opensuite/{agent-core,engine-client,api,web} typecheck` | **Pass** |
| Native paragraph authoring N-API | **Pass** (linked fresh `.node`) |

## Intentionally Deferred

* Affordance-driven recovery policies / reason-specific fallbacks
* Engine tool manifest
* Affordances on paragraphs, pictures, slides, sheets, ranges
* Separate affordance registry (handles becoming stale is enough for now)
* Engine: harden `insert_table_column` verify for empty `headerCells`
* Delete rows/columns / create_table / multi-column insert / lists / images
* N-API exposure of full paragraph formatting patch (indent, lineSpacing, keepWithNext, …)
* PPTX/XLSX engine runtimes; HTTP mutation endpoint
* Legacy `insert_paragraph_after` model tool (placement primitives supersede)

## Recommended Next Step

Restart API (`pnpm dev:api`) and browser-accept: blank DOCX → essay via `insert_paragraphs` + Heading 1 → center/spacing → bold → delete conclusion → insert before table.
