# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX editor, blank create, workspace agent; PPTX/XLSX storable only.
* Explorer versions rail: last 5 tips for the open document; view older tips read-only; restore truncates newer versions (DB + object storage) so that tip becomes editable. Each agent run rebinds to current tip via `getOwnedDocument`; operating instruction warns that restored tips discard higher version numbers. Sidebar polish: files use a tinted row with a left accent bar; versions render as a timeline (node, "Current" badge, elevated selected card); hover is a neutral wash; footer is a quiet "Add file" button.
* Engine-backed DOCX inspect/mutate via npm `@opensuitehq/engine@0.1.3` (semantic table cell/row edits + structured diagnostics). Engine-client keeps capability gates for older installs. API Docker image loads the native binding before deploy (glibc bookworm; not Alpine/musl).
* **Agent Core V3 (live)** — document-agnostic model/tool loop; API owns context, retrieval, DOCX tools, persistence, validation, and run lifecycle. Finish + soft stopReasons; dynamic tool surface via capability discovery; one persisted version per mutated run; live working preview.
* API capability catalog/session supplies a bounded root index, indexed list/search, run-local load, and next-turn tool projection. Existing DOCX specialist tools are nested under document domains; common tools remain available. Instruction skills now load as run-local model guidance, starting with scientific-paper writing; no skill becomes an executable tool. Raw capability lifecycle events include capability kind in the best-effort DB sink. Web tools and connectors remain deferred.
* Workspace targeting: Turn-1 manifest with IDs; explicit “this/current/open” or `workspace.select_document`; `workspace.search_documents` / `workspace.inspect_document` / rename / create-with-title / duplicate; single-target edit lock.
* Agent UX: progressive activity rows from SSE; clarification via `request_clarification`; Continue after max-turn/deadline; compact `[agent]` logs; opt-in `AGENT_RUN_TRACE=full`.
* Public marketing + auth (Google OAuth); centralized brand palette; API composition seam (`createOpenSuiteRuntime` / `createOpenSuiteApp`) for a future Cloud overlay. V2 retained off-path.

## Current Decisions

* Soft-delete; trash permanent purge clears working-document/checkpoint FKs; Empty trash + multi-select purge; optimistic concurrency; Rust SoT.
* Managed AI = OpenRouter; V3 owns model/tool loop; API owns shell/binding/persistence/lifecycle.
* agent-core-v3 stays document-agnostic; document identity switch is API-owned.
* No Rust duplicate op — application-level byte copy.
* Agent Panel shows execution state only — not CoT, not AgentRunReport telemetry.

## Intentionally Deferred

* Delete agent-core-v2; Phase 4 request context
* Rename/move/delete/folder tools; multi-document inspect
* Finish-as-read scheduling redesign
* AgentRunReport developer dashboard

## Recommended Next Step

Smoke the explorer versions rail: open a DOCX with ≥2 versions, view an older tip (read-only), restore it, then send an agent prompt and confirm the run binds the restored tip.
