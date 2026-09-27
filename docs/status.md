# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V3-2 (live)** — general policy + dynamic AVAILABLE CAPABILITIES; finish + soft stopReasons.
* **V3 Phase 3 observability** — `AgentRunMetrics` + API `AgentRunReport` / compact log (no DB/OTel; not shown in Agent Panel).
* **V3 lifecycle tools** — `workspace.create_blank_document` + `workspace.duplicate_current_document` with same-run active rebind; `document.created` SSE; report `transitions[]`.
* **Phase 3.5 Live Agent Activity UX** — progressive `AgentActivityGroup` / `ActivityRow` from existing SSE (`tool.*`, model-wait Thinking, lifecycle); read grouping; compact completion with total elapsed; no stacked Working… beside Thinking; no new progress protocol.
* V2 retained off-path. `pnpm dev:api` builds deps then `tsc -w` + `tsx watch`.
* **API composition seam** — `@opensuite/api` now exports `createOpenSuiteRuntime`, `createOpenSuiteApp`, and config loading. The self-host server remains a thin wrapper; a future Cloud API can register routes on the same Fastify app, Better Auth instance, and DB client.

## Just Completed

* **Mutation batching** — API exposes four focused DOCX batch tools for text replacement, paragraph styles, paragraph formatting, and text formatting. Items run in order on run-local bytes, stop on first failure with compact item diagnostics, and keep earlier edits. One successful batch advances one working preview revision; final flush still saves one version. Existing Rust operations and agent-core-v3 scheduling are unchanged. Tool guidance now favors coherent batches and multiple safe mutation calls per model turn. User-run guide creation: 6 model turns, 8 executed tools, 17 edits, 1 saved version, 31.08s total (30.89s model, 191ms tools), 82,977 input / 65,536 cached / 6,611 output tokens. One `STYLE_NOT_FOUND` was repaired in-run; first-page screenshot shows headings, subtitle, and bullets. This task differs from the 13-turn/76-tool rewrite baseline, so speed comparison is directional only.

* **Concise run logs** — completed agent runs now print one metrics line plus failed-tool lines; full report JSON is opt-in with `AGENT_RUN_REPORT_VERBOSE=1` (Cloud still stores the full report). Dev request logs no longer add blank lines. Better Auth errors omit exception objects that can contain session tokens.

* **Direct-context read efficiency** — a complete small DOCX is inspected by the engine before the first model call. On unchanged DIRECT state, the API allows one broad read and at most four total inspect/find reads, then asks the model to act on context; a mutation resets the read state. The live Cincinnati rewrite finished in 13 model turns with 3 inspections, 13 finds, and 58 successful text edits.

* **Duplicate/Continue repair** — an exact document copy retains DIRECT source content and its read guard until edited, so the model need not rediscover the copy. Max-turn/deadline runs now save a linked assistant status message, keeping their tool transcript in paginated conversation history after Continue; migration 0018 links older bounded runs at their original completion times. Continue appears as a compact conversation entry. The 20-turn limit already counted model calls only; tool calls are separate. The reported Cincinnati runs used 20 model calls each, with 39 then 20 tool calls and no edits to the copied document.

* **Agent activity and speed** — three animated dots follow the latest live transcript entry; the elapsed timer stays by Stop. Existing SSE heartbeats surface a stale connection. A successful DeepSeek V4.1 Flash run took 191.61s: 191.39s model, 220ms tools; turn 3 alone took 154.57s and 10,496 output tokens. The run used 11,311 reasoning tokens total. Agent calls request throughput routing and log provider plus reasoning tokens per turn; this model now requests low reasoning (OpenRouter default: high). The old run's provider is unknown.

* **One persisted version per agent run** — successful DOCX tools update run-local bytes; success, max turns, cancellation, deadline, or failure flushes the latest valid state once. Read-only runs add no version. Inspect handles and read guards follow the working revision. Final `document.version.advanced` refreshes the editor; live tool activity still streams. Creation keeps its seed version. Agent-core-v3 and Rust unchanged.
* **Live working DOCX preview** — successful run-local mutations emit `document.working.updated`; an authenticated active-run route serves current bytes without persistence. Cross-origin clients can read revision/base headers; missing metadata stops preview instead of refetching indefinitely. The editor coalesces revisions, loads clean previews in place, and keeps the saved version ID; dirty human edits block preview. Final `document.version.advanced` loads the canonical version. No engine or agent-core-v3 change.

* **Public launch docs** — root README now describes the connected DOCX path, real self-host requirements, BYOK, Cloud boundary, and alpha limits; concise contribution, security, license, roadmap, architecture, and real-media capture guidance added.

* **Google account lifecycle** — Better Auth native OAuth signup, verified-email linking, and returning-account sign-in are covered against PostgreSQL. A matching unverified password account remains unlinked; OAuth failures and email verification from a blocked sign-in return to web sign-in with safe instructions.

* **Google OAuth HTTPS request bridge** — Better Auth now receives the validated public `BETTER_AUTH_URL`, not Fastify's internal HTTP tunnel URL, when serving `/api/auth/*`; this preserves the public HTTPS context for OAuth callback session cookies. Regression test covers an internal proxy host. Google button has a local multicolor G SVG; no dependency added.

* **External-alpha Google sign-in** — Better Auth 1.7.2 native Google provider uses only OpenID identity scopes and the existing account/session tables; normal sessions remain unchanged. A verified local email may be linked only to Google's verified identity for the same email. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` must be supplied together; Google creation follows `ALLOW_SIGNUP` and Vercel's `NEXT_PUBLIC_ALLOW_SIGNUP` must match it.

* API integration stability — unrelated integration apps use shared non-network test model config; production validation is unchanged. Lease tests no longer clear shared rows, and checkpoint-tail queries retain PostgreSQL timestamp precision. DB integration suite: 217/217 pass.

* External-alpha public boundary — production public URLs require HTTPS; same-site auth defaults to `AUTH_CROSS_ORIGIN=false`; authenticated process-local write limits and fixed API security headers added. Cloudflare anonymous auth limits are documented for tunnel setup.

* **Semantic agent-thread titles** — existing nullable `agent_thread.title` is filled by a separate short title request from the current instruction plus existing working-set names/maps; it is not awaited by the V3 stream. Conditional persistence preserves manual renames; active title is the Agent Panel header, and Previous chats supports Rename while excluding the active session.
* **Agent response follow** — panel follows live text while already at the bottom, without pulling a reader away from earlier messages; leading quote markers in agent text are no longer displayed.
* **Agent transcript finish duplication** — one-turn `finish` no longer persists final answer as narration; panel omits narration immediately before `finish` when `message.content` is shown. Live answer streams, then reconciles to one persisted assistant message (reload-safe).
* **Agent context correctness** — run requests keep `activeDocumentId` (tool-bound primary) separate from submitted `documentIds` (additional tags); durable working set unions persisted members + active + tags. DIRECT uses verified complete DOCX content for the whole working set only when its combined token cost fits one shared limit; unsupported/incomplete documents fall back. Submitted tag IDs persist on the user message and render in its historical transcript entry.
* **Phase 2A.3 adaptive context planning** — single, unambiguous small active DOCX can enter first turn as compact complete content (including full tables); a 24k planner evidence cap separates practical context policy from physical model capacity. Larger, competing, or failed direct reads retain map + Phase 1 evidence fallback. Reports show planner budget and evaluated full-document cost.
* **Model/context accounting** — OpenRouter catalog `contextLength`/`maxOutputTokens` attached for managed + BYOK; explicit output/continuation/safety reserves replace blind 60%-of-window budget; `retrieval.availableEvidenceTokens` from real model window; agent-core-v3 preserves OpenRouter `usage.cost` + reasoning tokens; reports show `actualProviderCostUsd` vs estimated.
* **Phase 2A.2 durable working set** — persisted thread↔document membership restores active/tagged docs across runs; stale soft-deleted members are ignored; retrieval reports include available evidence budget; full diagnostic JSON is opt-in.
* **Phase 2A.1 pre-model foundation** — request working set (active + tagged docs), compact heading/table DOCX maps, report-level available-evidence budget, and existing retrieval as the first hierarchical context strategy; no schema or engine change.
* **Agent activity UX polish** — dropped redundant live `Working…` under Thinking; completed turns keep compact summary with total elapsed (including durable transcript path).
* **Phase 1 pre-model retrieval** — API-only workspace metadata ranking before model invocation; selected DOCX artifacts are inspected through the existing engine-client path and injected once with exact-version provenance. PPTX/XLSX remain metadata-only; retrieval errors fall back to the previous model path. Run reports now log artifact/evidence counts, duration, context size, and candidates.
* **Deploy restart loop** — Dokploy image was missing gitignored `0013`/`0014` migration SQL (`No file … found`); entrypoint now uses programmatic migrate with real pg errors; engine check uses `require()` (pnpm layout).
* **Prod API URL join** — web strips trailing `/` on `NEXT_PUBLIC_API_URL`; API `GET /` returns plain `OpenSuite API` for browser up-checks. Hosted web must point at API host (not Vercel apex/www).
* **Engine npm cutover** — `@opensuite/engine-client` depends on `@opensuitehq/engine@0.1.1` from npm (not sibling `link:` / vendor stub). Docker `node:22-bookworm-slim` (glibc) validated: installs `engine-linux-arm64-gnu@0.1.1`, raw + engine-client smoke, API soft-boots without sibling/vendor. Alpine/musl unsupported.
* **Live transcript ordering** — SSE narration now appends within ordered live segments beside tool activities; the existing completed-step renderer is shared, then durable steps replace live entries at terminalization.
* **Live waiting + final response** — Thinking marks initial and post-tool model waits; the final model turn streams normal assistant text before an empty terminal `finish` call, keeping one model turn and one durable final message.
* **Max-turn terminalization** — `max_turns` remains a failed run status with a deterministic incomplete/preserved-changes message and a linked assistant history entry for its durable transcript.
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
* **Phase 2A efficiency hardening** — verified DIRECT content remains model-facing until its version changes, including across an exact duplicate; version-aware read guard suppresses repeated or excessive unchanged reads while retaining targeted access. Older duplicate observations collapse; Continue uses persisted tool steps, original goal, and current document/version. Reports count suppressed reads. Live dogfood awaits database access.
* **Agent failure clarity** — known managed-AI and no-active-document failures persist safe, actionable reasons for the panel; managed failures link to AI settings. OpenRouter tool-result names are normalized in model-facing context, and no-document creation runs instruct the model to create before editing.
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
| agent-core-v3 unit (26) | Pass |
| API unit (221; 20 skipped) | Pass |
| Model accounting live OpenRouter E2E | Pass (`availableEvidenceTokens`, ctx=1048576, actual cost) |
| Context lifecycle C1–C7 targeted API checks | Pass |
| Phase 6A API retrieval + lifecycle/report tests (22) | Pass |
| Phase 1 workspace retrieval API tests | Pass |
| engine-client tests (13) | Pass (npm `@opensuitehq/engine@0.1.1` + darwin-arm64) |
| web agent-progress + message unit (41) | Pass |
| web agent-messages + reconciliation (A–F) | Pass |
| web typecheck | Pass |
| web production build (`next build --webpack`) | Pass |
| Duplicate/Continue/retrieval focused API tests (81) | Pass |
| Direct-context read efficiency focused API tests (61) | Pass |
| full web test command | 17 existing import-resolution failures under Node type stripping; focused message/progress tests pass |
| API isolation one-turn finish transcript | Pass |
| Run-local DOCX and terminal flush tests | Pass |
| Working preview API/editor focused checks | Pass (39 API, 37 web; API/web typechecks and web build) |
| Mutation batch DOCX, engine-client, agent-core-v3, lifecycle/read-loop focused checks | Pass (API focused 11; batch/version 5; engine-client 13; core 26; lifecycle/read-loop 63 with verbose report flag) |
| Browser Agent panel (Hello world) | Pass — answer once; reload once; screenshots `.tmp/transcript-dup-fix/09|10` |
| Fixture screenshots A–G (`/.tmp/phase35-screenshots`) | Inspected |
| Manual live OpenRouter dogfood | User run succeeded in 191.61s before low-reasoning change: 10 turns, 13 tools, 1 saved version |

## Intentionally Deferred

* Delete agent-core-v2; Phase 4 request context
* Rename/move/delete/folder tools; multi-document inspect
* Finish-as-read scheduling redesign
* AgentRunReport developer dashboard

## Recommended Next Step

Recoverable-error UX: show a terminal failure only when the agent cannot repair it during the run.
