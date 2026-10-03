# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX editor, blank create, workspace agent; PPTX/XLSX storable only.
* Engine-backed DOCX inspect/mutate via npm `@opensuitehq/engine@0.1.3` (semantic table cell/row edits + structured diagnostics). Engine-client keeps capability gates for older installs. API Docker image loads the native binding before deploy (glibc bookworm; not Alpine/musl).
* **Agent Core V3 (live)** — document-agnostic model/tool loop; API owns context, retrieval, DOCX tools, persistence, validation, and run lifecycle. Finish + soft stopReasons; dynamic tool surface (specialists via `tools.load_group`); one persisted version per mutated run; live working preview.
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

Deploy/reload API so trash purge picks up working-document + checkpoint FK cleanup, then verify Empty trash / multi-select permanent delete in `/app/trash`.
