# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V3-2 (live)** — general policy + dynamic AVAILABLE CAPABILITIES; finish + soft stopReasons.
* **V3 Phase 3 observability** — `AgentRunMetrics` + API `AgentRunReport` / compact log (no DB/OTel; not shown in Agent Panel).
* **V3 lifecycle tools** — `workspace.create_blank_document` + `workspace.duplicate_current_document` with same-run active rebind; `document.created` SSE; report `transitions[]`.
* **Phase 3.5 Live Agent Activity UX** — progressive `AgentActivityGroup` / `ActivityRow` from existing SSE (`tool.*`, model-wait Thinking, lifecycle); read grouping; compact completion; no new progress protocol.
* V2 retained off-path. `pnpm dev:api` builds deps then `tsc -w` + `tsx watch`.

## Just Completed

* **Engine npm cutover** — `@opensuite/engine-client` depends on `@opensuitehq/engine@0.1.1` from npm (not sibling `link:` / vendor stub). Docker uses bookworm/glibc; Alpine/musl unsupported.
* **Live transcript ordering** — SSE narration now appends within ordered live segments beside tool activities; the existing completed-step renderer is shared, then durable steps replace live entries at terminalization.
* **Persistent completed-run transcript v1** — durable, presentation-safe narration/tool steps in `agent_step`; final answer remains the linked `agent_message`; completed latest run rehydrates after reopen.
* **Phase 6B** — bounded Rust `table_rows` inspection and request-local last-three-row context for high-confidence table continuation.
* **Context Lifecycle C1** — API-only deterministic recent-tail projection bounds persisted history sent to V3; full DB/UI history remains unchanged.
* **Context Lifecycle C2** — immutable checkpoint persistence plus checkpoint + C1-tail model composition.
* **Context Lifecycle C3** — best-effort post-success incremental checkpoint compaction; latest checkpoint + recent tail remains model-facing.
* **Context Lifecycle C4** — conservative known-model token budgeting for first-turn history and C3 compaction input; unknown models retain C1 fallback bounds.
* **Context Lifecycle C5** — bounded SQL history reads: execution loads at most 40 recent rows, while compaction uses scalar tail stats and a bounded oldest source batch.
* **Context Lifecycle C6** — `GET /messages` is now cursor-paginated (`(createdAt, id)`, default 50 / max 100, newest page or `before` cursor, `{ messages, page: { hasMore, oldestCursor } }`); Agent Panel loads only the latest page on open, merges pages by id (dedupes optimistic/live entries), and offers an explicit "Load earlier messages" affordance that prepends older pages while preserving scroll position. Full history remains in Postgres and reachable via pagination; model/runtime context (C1–C5) untouched.
* **Context Lifecycle C7** — API-owned deterministic in-run observation projection via composed `projectMessages`: keeps last 2 tool turns verbatim; shrinks older successful `document.inspect` / `document.find` JSON in place (pairing-safe); does not compact mutation failures; Phase 6 first-turn retrieval composition preserved; raw V3 transcript unchanged; no agent-core-v3 / source-shaping / C1–C6 changes.
* **V3 run lifecycle hardening** — pre-model/setup throws (e.g. missing checkpoint table) terminalize via `settleTerminalRunFailure`; run-manager safety net for escaped background rejects; cancel route + UI cancel lock idempotent; progress reducer dedupes terminal `cancelled`/`failed`/`completed`. Local DB must apply migrations through `0014_slimy_mystique` (`pnpm db:migrate`) for C2 checkpoint table.
* **Phase 6A** — API-only, version-keyed slim structure cache plus conservative first-turn retrieval; no V3/engine prompt or protocol changes.
* **Phase 5A** — `body_blocks` now carries paragraph style/heading and slim table structure from Rust; no app-side OOXML parsing.
* **DB outage UX** — API boot no longer crashes on lease-clear when Postgres is down; soft banner + keep shell when session exists; 503 copy = "No connection with the database".
* **Phase 3.5** — progressive Agent activity rows (fixtures `/dev/agent-panel-ux`).

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT.
* Managed AI = OpenRouter; V3 owns model/tool loop; API owns shell/binding/persistence/lifecycle.
* agent-core-v3 stays document-agnostic; document identity switch is API-owned.
* No Rust duplicate op — application-level byte copy.
* Agent Panel shows execution state only — not CoT, not AgentRunReport telemetry.

## Verification Status

| Check | Status |
|---|---|
| agent-core-v3 unit (21) | Pass (prior) |
| Context lifecycle C1–C7 targeted API checks | Pass |
| Phase 6A API retrieval + lifecycle/report tests (22) | Pass |
| engine-client tests (13) | Pass (npm `@opensuitehq/engine@0.1.1` + darwin-arm64) |
| web agent-progress + related unit | Pass |
| web typecheck | Pass |
| Fixture screenshots A–G (`/.tmp/phase35-screenshots`) | Inspected |
| Manual live OpenRouter A–D / dogfood | pending (user) |

## Intentionally Deferred

* Delete agent-core-v2; Phase 4 request context
* Rename/move/delete/folder tools; multi-document inspect
* Finish-as-read scheduling redesign
* AgentRunReport developer dashboard

## Recommended Next Step

Optional follow-up: source-shape large tool results at execution (`document.find` match cap, slim `inspect(tables)`, omit unused mutation `versionId` from model-facing JSON). Then dogfood a multi-turn inspect/find/mutate run and confirm later-turn projected input stays bounded.
