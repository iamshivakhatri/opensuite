# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX editor, blank create, workspace agent; PPTX/XLSX storable only.
* Explorer versions rail: last 5 tips for the open document; view older tips read-only; restore truncates newer versions (DB + object storage) so that tip becomes editable. Each agent run rebinds to current tip via `getOwnedDocument`; operating instruction warns that restored tips discard higher version numbers. Sidebar polish: files use a tinted row with a left accent bar; versions render as a timeline (node, "Current" badge, elevated selected card); hover is a neutral wash; footer is a quiet "Add file" button.
* Engine-backed DOCX inspect/mutate via npm `@opensuitehq/engine@0.1.3` (semantic table cell/row edits + structured diagnostics). Engine-client keeps capability gates for older installs. API Docker image loads the native binding before deploy (glibc bookworm; not Alpine/musl).
* Phase 1 local-engine development exposes a typed, bounded DOCX style snapshot through engine-client. It keeps named-style, direct, and effective formatting separate and does not add product or model behavior. The npm engine pin remains unchanged. Local dogfood: set absolute `OPENSUITE_ENGINE_PATH` in `.env` to sibling `opensuite-engine/crates/opensuite-node/index.js`; API boot logs the source; `pnpm --filter @opensuite/engine-client style-smoke` checks the N-API path.
* Phase 2 personal StyleProfiles: schema v1, deterministic normalization, owner-scoped PostgreSQL CRUD (migration `0023`), authenticated API, and dynamic `style.*` tools. Exact saved-version provenance; no source edits or raw snapshots in model context. Explicit “Learn the document style from this document” binds the open saved version; completion shows “Saved style profile” or “Completed” for profile reads. Three real DOCX persistence/restart checks and Blue Harbor learning/list/get through the real agent loop passed with the local engine, isolated PostgreSQL schema, and scripted model (no paid calls). See `docs/style_profiles.md`.
* Phase 3 saved-style application: API builds a deterministic supported-field plan, styles existing semantic roles through the local engine, stages and verifies content before adopting working bytes, and reports bounded fidelity. `style.apply_profile` resolves owner-scoped profiles and uses the existing one-save-per-run path. Named saved-style prompts recommend list/get/apply; generic packs cannot substitute, and unverified saved-style completion fails. Actual résumé bracket placeholders now warn; the UI labels successful application as a document update. Blue Harbor → new and existing Cincinnati newsletter targets passed with 27 matched fields, zero mismatches, unchanged source/content/list semantics, and no paid calls. Line spacing/keep flags, richer list/header/footer/layout treatment, and table width declarations remain explicit limitations. Engine/npm pin unchanged; engine-client only adds the existing native list inspection type.
* **Agent Core V3 (live)** — document-agnostic model/tool loop; API owns context, retrieval, DOCX tools, persistence, validation, and run lifecycle. Finish + soft stopReasons; dynamic tool surface via capability discovery; one persisted version per mutated run; live working preview.
* API capability catalog/session supplies a bounded root index, indexed discovery, a small prompt-matched Turn 1 shortlist, run-local load, and next-turn projection. The capability folder separates core state, definitions, runtime projection, and telemetry; its README explains registration. DOCX specialist tools are nested under document domains; common tools remain available. Eight document-family skills and five reusable style packs load as instruction capabilities alongside scientific-paper guidance. Style packs recommend up to four currently loadable formatting companions so one load can expose the guidance and real DOCX tools; their instructions use guaranteed blank-document styles and direct list, text, paragraph, table, and layout operations. `compute.calculator` returns exact integer strings with BigInt and labels decimal, non-integer division, percentage, and root results as approximate. Raw capability lifecycle events include recommendations and kind; Cloud Admin aggregates them in Usage. Web tools and connectors remain deferred.
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

Manually apply the saved Blue Harbor profile in the local agent panel and review the unsupported-field disclosure. Do not start Phase 4 yet.
