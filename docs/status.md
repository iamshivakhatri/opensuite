# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V3-2 (live)** — general policy + dynamic AVAILABLE CAPABILITIES; finish + soft stopReasons.
* **V3 Phase 3 observability** — `AgentRunMetrics` + API `AgentRunReport` / compact log (no DB/OTel; not shown in Agent Panel).
* **V3 lifecycle tools** — `workspace.create_blank_document` + `workspace.duplicate_current_document` with same-run active rebind; `document.created` SSE; report `transitions[]`.
* **Phase 3.5 Live Agent Activity UX** — progressive `AgentActivityGroup` / `ActivityRow` from existing SSE (`tool.*`, model-wait Thinking, lifecycle); read grouping; compact completion with total elapsed; no stacked Working… beside Thinking; no new progress protocol.
* V2 retained off-path. `pnpm dev:api` builds deps then `tsc -w` + `tsx watch`.

## Just Completed

* **External-alpha Google sign-in** — Better Auth 1.7.2 native Google provider uses only OpenID identity scopes and the existing account/session tables; normal sessions remain unchanged. A verified local email may be linked only to Google's verified identity for the same email. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be supplied together; Google creation follows `ALLOW_SIGNUP` and Vercel's `NEXT_PUBLIC_ALLOW_SIGNUP` must match it.

* API integration stability — unrelated integration apps use shared non-network test model config; production validation is unchanged. Lease tests no longer clear shared rows, and checkpoint-tail queries retain PostgreSQL timestamp precision. DB integration suite: 217/217 pass.

* External-alpha public boundary — production public URLs require HTTPS; same-site auth defaults to `AUTH_CROSS_ORIGIN=false`; authenticated process-local write limits and fixed API security headers added. Cloudflare anonymous auth limits are documented for tunnel setup.

* **Semantic agent-thread titles** — existing nullable `agent_thread.title` is filled by a separate short title request from the current instruction plus existing working-set names/maps; it is not awaited by the V3 stream. Conditional persistence preserves manual renames; active title is the Agent Panel header, and Previous chats supports Rename while excluding the active session.
* **Agent response follow** — panel follows live text while already at the bottom, without pulling a reader away from earlier messages; leading quote markers in agent text are no longer displayed.
* **Agent transcript finish duplication** — one-turn `finish` no longer persists final answer as narration; panel omits narration immediately before `finish` when `message.content` is shown. Live answer streams, then reconciles to one persisted assistant message (reload-safe).
* **Agent context correctness** — run requests keep `activeDocumentId` (tool-bound primary) separate from submitted `documentIds` (additional tags); durable working set unions persisted members + active + tags. DIRECT uses verified complete DOCX content for the whole working set only when its combined token cost fits one shared limit; unsupported/incomplete documents fall back. Submitted tag IDs persist on the user message and render in its historical transcript entry.
* **Phase 2A.3 adaptive context planning** — single, unambiguous small active DOCX can enter first turn as compact complete content (including full tables); a 24k planner evidence cap separates practical context policy from physical model capacity. Larger, competing, or failed direct reads retain map + Phase 1 evidence fallback. Reports show planner budget and evaluated full-document cost.
* **Model/context accounting** — OpenRouter catalog `contextLength`/`maxOutputTokens` attached for managed + BYOK; explicit output/continuation/safety reserves replace blind 60%-of-window budget; `retrieval.availableEvidenceTokens` from real model window; agent-core-v3 preserves OpenRouter `usage.cost` + reasoning tokens; reports show `actualProviderCostUsd` vs estimated.
* **Phase 2A.2 durable working set** — persisted thread↔document membership restores active/tagged docs across runs; stale soft-deleted members are ignored; retrieval reports include available evidence budget; diagnostic JSON is multiline.
* **Phase 2A.1 pre-model foundation** — request working set (active + tagged docs), compact heading/table DOCX maps, report-level available-evidence budget, and existing retrieval as the first hierarchical context strategy; no schema or engine change.
* **Agent activity UX polish** — dropped redundant live `Working…` under Thinking; completed turns keep compact summary with total elapsed (including durable transcript path).
* **Phase 1 pre-model retrieval** — API-only workspace metadata ranking before model invocation; selected DOCX artifacts are inspected through the existing engine-client path and injected once with exact-version provenance. PPTX/XLSX remain metadata-only; retrieval errors fall back to the previous model path. Run reports now log artifact/evidence counts, duration, context size, and candidates.
* **Deploy restart loop** — Dokploy image was missing gitignored `0013`/`0014` migration SQL (`No file … found`); entrypoint now uses programmatic migrate with real pg errors; engine check uses `require()` (pnpm layout).
* **Prod API URL join** — web strips trailing `/` on `NEXT_PUBLIC_API_URL`; API `GET /` returns plain `OpenSuite API` for browser up-checks. Hosted web must point at API host (not Vercel apex/www).
* **Engine npm cutover** — `@opensuite/engine-client` depends on `@opensuitehq/engine@0.1.1` from npm (not sibling `link:` / vendor stub). Docker `node:22-bookworm-slim` (glibc) validated: installs `engine-linux-arm64-gnu@0.1.1`, raw + engine-client smoke, API soft-boots without sibling/vendor. Alpine/musl unsupported.
* **Live transcript ordering** — SSE narration now appends within ordered live segments beside tool activities; the existing completed-step renderer is shared, then durable steps replace live entries at terminalization.
* **Live waiting + final response** — Thinking marks initial and post-tool model waits; the final model turn streams normal assistant text before an empty terminal `finish` call, keeping one model turn and one durable final message.
* **Max-turn terminalization** — `max_turns` remains a failed run status but is settled as an expected bounded stop, with a deterministic incomplete/preserved-changes message and run-owned durable transcript shown without a final assistant message.
* **Continue after max turns** — only `AGENT_MAX_TURNS` runs expose Continue; it starts a fresh API-owned 20-turn run from the original task and current document state, preserving the partial transcript.
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
| agent-core-v3 unit (24) | Pass |
| API unit (199; 17 skipped) | Pass |
| Model accounting live OpenRouter E2E | Pass (`availableEvidenceTokens`, ctx=1048576, actual cost) |
| Context lifecycle C1–C7 targeted API checks | Pass |
| Phase 6A API retrieval + lifecycle/report tests (22) | Pass |
| Phase 1 workspace retrieval API tests | Pass |
| engine-client tests (13) | Pass (npm `@opensuitehq/engine@0.1.1` + darwin-arm64) |
| web agent-progress unit (26) | Pass |
| web agent-messages + reconciliation (A–F) | Pass |
| web typecheck | Pass |
| API isolation one-turn finish transcript | Pass |
| Browser Agent panel (Hello world) | Pass — answer once; reload once; screenshots `.tmp/transcript-dup-fix/09|10` |
| Fixture screenshots A–G (`/.tmp/phase35-screenshots`) | Inspected |
| Manual live OpenRouter A–D / dogfood | pending (user) |

## Intentionally Deferred

* Delete agent-core-v2; Phase 4 request context
* Rename/move/delete/folder tools; multi-document inspect
* Finish-as-read scheduling redesign
* AgentRunReport developer dashboard

## Recommended Next Step

Manual OpenRouter dogfood of direct context on a small DOCX; then decide whether multi-document source allocation needs a later phase.
