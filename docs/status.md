# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V3-2 (live)** — general policy + dynamic AVAILABLE CAPABILITIES; finish + soft stopReasons.
* **V3 Phase 3 observability** — `AgentRunMetrics` + API `AgentRunReport` / compact log with stable vocabulary (`toolCalls`, `editsApplied`, `persistedVersions`, `toolErrors`; no DB/OTel; not shown in Agent Panel).
* **V3 lifecycle tools** — `workspace.create_blank_document` + `workspace.duplicate_current_document` with same-run active rebind; `document.created` SSE; report `transitions[]`.
* **Phase 3.5 Live Agent Activity UX** — progressive `AgentActivityGroup` / `ActivityRow` from existing SSE (`tool.*`, model-wait Thinking, lifecycle); read grouping; compact completion with total elapsed; no stacked Working… beside Thinking; no new progress protocol.
* V2 retained off-path. Public `pnpm dev:api` builds deps then runs API via `tsx watch`. Cloud `pnpm dev:api` builds + `tsc -w` public `@opensuite/api...` into `dist/` and reloads the Cloud overlay on those changes.
* **API composition seam** — `@opensuite/api` now exports `createOpenSuiteRuntime`, `createOpenSuiteApp`, and config loading. The self-host server remains a thin wrapper; a future Cloud API can register routes on the same Fastify app, Better Auth instance, and DB client.

## Just Completed

* **Readable full-trace aggregation** — `AGENT_RUN_TRACE=full` Markdown no longer writes one section per `reasoning-delta` / `text-delta` / `tool-input-*` event. Stream fragments accumulate in memory per model turn and flush once as complete Reasoning, Assistant Text, and Tool Calls blocks (Partial-labeled on error/cancel). Tool started/result/error collapse into one Tool Result/Error/Skipped block; `responseMessages` and delta dumps are not repeated. Trace format version 2. Observability only; agent behavior unchanged.

* **Phase 2 human-turn boundary correction** — runtime-induced model turns now keep the full same-run provider exchange after edits and reads; Phase 1 still refreshes the current DIRECT working snapshot. Later human-triggered runs load bounded coherent user/final-assistant turns from durable messages and run links, with deterministic status and unique tool names from persisted steps. A finish-only model turn retains the last user-visible text for durable settlement; runs genuinely lacking a reply keep an explicit terminal status. In-run checkpoint code was removed; full debug tracing remains separate from model-facing history.

* **Readable full-log filenames** — full trace files use `run_id_10-01-2026_09-05-06-AM-EDT.md` in America/New_York time. Native date formatting handles daylight saving; timestamp metadata stays UTC. All 9 trace tests, API build/typecheck, and `git diff --check` pass; summer/winter names and filename safety are covered.

* **Phase 1 current-document continuity** — complete DIRECT runs keep one API-owned current snapshot across working revisions. Successful edits make it stale by revision; async message projection refreshes it once from run-local engine bytes before the next model call and reuses it on unchanged turns. The same Markdown formatter and initial eligibility remain; source snapshots stay intact and stale target retrieval evidence is removed after refresh. No intermediate version, storage read, handle-lifetime change, or DOCX rule in V3 (its existing projection hook now accepts async results). Full traces record current/snapshot revisions, dirty/refreshed/available, size/tokens, duration, and refresh failures. Over-limit/incomplete/failed refreshes omit stale content, release DIRECT read suppression, and retry only after another edit.

* **Material-ambiguity clarification experiment** — always-visible `request_clarification({ question })` is a read-kind terminal tool that returns one user-facing question through existing `message.completed` / assistant-message persistence and `completed_with_input_needed` settlement. Policy asks early only when conflicting/missing facts leave materially different outcomes; excludes typos, fuzzy matches, selector reads, deterministic recovery and delegated choices. No edits/version from clarification alone; earlier successful edits still save once. A normal same-thread reply starts a fresh run with the request/question history. Question-only schema; no structured choices, new state machine, generic runtime or retrieval changes. Initial tool surface is now 17 tools; specialists remain hidden until loaded.

* **Local full agent-run traces** — opt-in `AGENT_RUN_TRACE=full`, optional `AGENT_RUN_TRACE_DIR` (default local/gitignored `.agent-traces/`). API-owned Markdown writer appends retrieval/context, post-projection/post-alias requests immediately before `streamText`, then aggregates SDK stream deltas into complete reasoning/text/tool-call blocks per turn (not per-token sections), plus grouped tool results, next-turn projected observations, metrics, version saves, validation and durable settlement. V3 adds one optional diagnostic callback; disabled mode performs no trace serialization. Credentials/model config and error transport fields are excluded. No prompts, retrieval/C7, tools, document behavior, frontend, DB or telemetry changes.

* **Dynamic model-facing tools** — optional, generic V3 `projectTools({ tools, turn, messages })` snapshots schemas and executors each turn; hidden tools cannot execute in the loading turn. API keeps 15 existing tools + `tools.load_group` common and places 26 specialists in six run-local, monotonic groups. Installed engine inventory: 41 → 16 initial tools; serialized schema size 36,248 → 11,831 chars (67.4% smaller). Logs: `tool_surface` per turn and `tool_surface_summary` per run. Model configuration, scheduler, handles, retrieval, C7, validation, aliases, and Rust unchanged. Full inventory and metrics are in `docs/agent_core.md`.

* **Same-turn DOCX handle reuse (Phase 1)** — the API now preserves inspected handles within one model turn across table formatting/widths/shading/cell formatting and paragraph formatting/style/text formatting. All other successful edits still clear handles immediately; an edited turn expires handles before the next model call or terminal save. Rust stays authoritative, V3 scheduling/failure skipping stays unchanged, and earlier successful bytes still save once after partial failure. Log: `[agent] mutation_turn turn=… sameTurnMutations=… compatibleMutations=… handleReuses=…`; stale diagnostics now include `modelTurn` and distinguish `model_turn` expiry from immediate `mutation` expiry.

* **Live DOCX preview after blank creation** — successful agent mutations were invisible because the new editor showed a false `Unsaved` state, which blocks both working previews and later version reloads. Initial imports now ignore dirty events until the editor is ready; captured input marks a local edit only when it is a real input in editable document content. Editor readiness retries a pending preview. Real unsaved edits still block agent reloads.

* **Blank-document STALE_HANDLE fix** — a Luna rerun showed `placement.kind: "start"` or `"end"` with `placement.handle: ""`. The shared stale check incorrectly treated the empty string as an opaque handle, even after inspect. It now ignores that field only for start/end; before/after still require an inspected handle. Paragraph tool descriptions explain the boundary placement, and bounded stale diagnostics remain available.

* **Provider-safe tool names** — OpenAI-compatible models (e.g. `gpt-5.6-luna`) reject dotted tool names (`document.inspect`). Schema names sent to the model now use `_` instead of `.`; the runtime maps calls back to internal dotted names for execution/events. Stream `error` parts and `finishReason: error` fail the run (UI shows failure) instead of silently completing empty. `describeRunFailure` also recognizes `tools[N].name` rejections.

* **Agent action follow-up** — removed the DeepSeek V4.1 Flash 8,192-token default after two Northstar reruns spent the entire cap on reasoning before any tool call. Agent turns have no forced output cap unless `AGENT_MAX_OUTPUT_TOKENS` is set; explicit caps still respect the provider ceiling. The existing operating instruction now asks for the first useful tool call without a narrated full plan. Phase A `length` safety and discarded-tool logging remain.

* **Phase A reasoning-budget follow-up** — two live Northstar reruns ended correctly at `output_limit` after ~19–20s with ~8.2k output, nearly all reasoning, and no tool calls. The installed OpenRouter adapter forwards `reasoning.max_tokens`, but OpenRouter's current DeepSeek V4.1 Flash catalog advertises effort levels without direct token-budget support; its docs say token budgets on effort-only models are converted to effort. `reasoning.effort: low` stays in place; no 4,096-token budget was added because it would not reliably reserve output for tools.

* **Agent runtime reliability Phase A** — any `length` finish stops as `output_limit` before emitted tools run or another turn starts. Turn logs show configured effective caps and `discardedTools` count; same-run reasoning replay is unchanged.

* **Final cleanup review** — confirmed API/V3/engine and web ownership, kept current production file locations and names, removed `execution.ts` test-only re-exports and unused panel prop type exports, and updated `AGENTS.md` to describe the live paths and commands. No runtime or document behavior change.

* **Cleanup Phase 5B (API agent route readability)** — moved abandoned-run durable repair (`RUN_ABANDONED` status write + orphan lease release) from SSE `GET …/events` into `run-manager.repairAbandonedRun`. Route keeps auth/validate/subscribe/stream/SSE terminal synthesis; DB/status-repair details no longer dominate. Behavior-preserving; AGENTS.md unchanged.

* **Cleanup Phase 5A (web API client)** — shared `api-client.ts` (`ApiError`, `apiFetch`, `parseApiError`) used by `api.ts`, `ai-settings-api.ts`, `storage-api.ts`. One error model; AI/storage now get `API_UNREACHABLE` + `DATABASE_UNAVAILABLE` like the main client. Feature operation files stay separate. `api-health` unchanged (soft-fail). AGENTS.md unchanged.

* **Cleanup Phase 4B (readability)** — extracted agent composer UI from `document-agent-panel.tsx` into nearby `agent-composer.tsx` (`AgentComposer`; local mention/keyboard/resize). Panel keeps draft/tags/attachments state + submit/stop/SSE/run ownership. Behavior-preserving.

* **Cleanup Phase 4A (readability)** — extracted agent transcript/display from `document-agent-panel.tsx` into nearby `agent-transcript.tsx` (`AgentTranscript`, `RunTranscript`, `CompletedRunTranscript`, `WorkingDots`). Panel keeps thread/run/SSE/submit/continue/cancel/composer ownership. Behavior-preserving.

* **Cleanup Phase 3B (readability)** — extracted event relay/report logging (`run-events.ts`: transcript, `createRunEventHandler`, `emitRunReport`, `summarizeError`) and terminal settlement (`run-settlement.ts`: finalize/settle failure, lease keep/release, `boundedStopMessage`/`describeRunFailure`) from `execution.ts`. Restored Phase 3A `workspace_retrieval_skipped` sanitization via `summarizeError`. Behavior-preserving.

* **Cleanup Phase 3A (readability)** — extracted first-turn/context prep from `apps/api/src/agent/execution.ts` into `agent-context.ts` (`loadHistory`, `prepareContext`, retrieval load, `firstTurnContextProjection`, `composeProjectMessages`). Run lifecycle orchestration stays in `execution.ts`. Behavior-preserving; no agent-core-v3 / retrieval semantics / AGENTS.md changes.

* **Cleanup Phase 2 (dead code only)** — removed unused symbols/helpers across web+api+engine-client fixtures (orphan poll helper, tab/storage/AI wrappers, superseded agent-progress helpers, unused log formatters, unused execution `.execute` wrapper, unused DOCX fixture). Trimmed matching tests. No architecture/agent/document behavior changes. Deferred: agent-core-v2, mock engine/contracts, `/dev/agent-panel-ux`, auth CLI, wasm emission, public Cloud API aliases. Remaining findings are mostly MEDIUM/LOW — stop further dead-code sweeps; next passes should be readability.

* **Cleanup Phase 1 (dead code only)** — removed unused `document-canvas.tsx` re-export, unused `tab-overflow` (+ its test), and four unreferenced symbols (`ResolvedV2ExecutionModel`, `SAFE_INPUT_FRACTION`, `summarizeAgentActivities`, `readStoredTheme`). No architecture/agent/document behavior changes. Deferred: agent-core-v2, mock engine transport, `/dev/agent-panel-ux`, auth CLI, wasm emission.

* **Agent latency pass** — V3 turn metrics/logs now separate first reasoning, visible text, and tool-input timing; completion logs include finish reason. Small action-first/DIRECT wording edits. Optional `AGENT_MAX_OUTPUT_TOKENS` (1–16,384) caps the actual model request and its input reserve. Catalog maximum remains a capability ceiling, not a generation cap.

* **Frontend request noise** — idle click/focus no longer re-hits AI prefs, provider credentials, or document metadata. Shared React Query keys (5m AI settings, existing doc/list staleTimes); agent panel reuses workspace docs cache; removed DOCX focus/visibility soft-refresh and agent BYOK focus refetch; dropped redundant `refreshKey` double-invalidate. Mutations still invalidate/setQueryData. Focused cache tests + web typecheck pass.

* **Public marketing polish** — `/how-it-works` copy is role-agnostic (any .docx change, not a monthly-report demo); public `SiteWordmark` uses the same favicon-style `BrandMark` as the app shell.
* **Centralized brand palette** — `apps/web/src/styles/brand-palette.css` is the only place with raw brand colors: 10 `--brand-*` vars, light + dark per palette. Live: ROSE (`#b4234a`). Others wrapped in comments; swap per file header. Favicon `icon.svg` cannot read CSS vars — sync its stops when switching. `globals.css` derives soft/line/hover/selected for app root and `.os-site`.
* **Public site routes** — main marketing sections are real pages (`/product`, `/how-it-works`, `/principles`, `/architecture`, `/scope`, `/open-source`); nav shows active route.

* **Public marketing + auth UI** — landing, privacy, terms, 404, and auth pages; `/` renders immediately (signed-in redirect non-blocking); health poll + outage banner only on `/app/*` and auth. Site serif + `.os-site` tokens scoped to public chrome.

* **Agent tool ergonomics** — table text edits, structural formatting, and contiguous row insertion now describe the existing one-call path; the operating instruction uses exact retrieval selectors before inspection and favors batch/multi-target operations. No runtime or engine change.

* **Engine 0.1.2 + exact table targeting** — npm engine 0.1.2 advertises structural multi-cell formatting through the existing capability gate; one call formats several inspected cells and expires old handles. DOCX DIRECT, map, and targeted evidence now show exact version-local `headerCells` + duplicate-header `occurrence` selectors; retrieval handles are not mutation handles.

* **Recurring-report fix pass 2** — API post-save validation now checks narrow additive table totals using the engine’s 10-row inspection pages, recognizes successful structure mutations and blank creation, skips period checks without a rollover, flags only future-sounding period statements, and labels input-needed placeholders as unresolved input. No Rust, model, or UI change.

* **Recurring-report fix pass 1** — update-only source rule preserves facts without explicit replacement evidence; missing requested facts can finish as `completed_with_input_needed` with a clear user response. Retrieval now scopes to the target, current attachments, and named references unless broader workspace reports are requested. Clear new-document requests start without a stale active target. No extra model call or Rust change.

* **Readable agent run logs** — compact `[agent]` lines for RETRIEVAL / TURN (LLM start, first reasoning/text/tool input, done+usage+tools+finish reason) / TOOL ✓✗ / SAVE / VALIDATION / DONE. Routine GET poll noise filtered; context compaction logs only when triggered. `AGENT_RUN_REPORT_VERBOSE=1` still dumps full report JSON.

* **Phase 3 verification/logging fix** — explicit report transitions now recognize month/year/quarter across descriptive titles; table dimensions use successful structural tool names to label supported changes as expected and unexplained loss as warning. API logs now show retrieval/target/source names, live tool outcomes, saved version, validation, and the existing per-turn/final metrics. No runtime, Rust, or UI changes in this fix.

* **Continue presentation** — max-turn/deadline stops show a neutral saved assistant status with Continue beneath it. Continue remains a new user message and starts from the saved document/current run context; prior messages stay visible. Other failures retain error treatment. The 27.29s user run made 20 model turns, 21 tools, 17 edits, and one saved version; Together served 278,656 of 304,797 input tokens from cache.

* **Verified Document Update v1** — after a mutated DOCX is saved, API validation checks the target version, source versions, saved DOCX inspection, structure, explicit old month/year references, and obvious placeholders. Structured checks persist in the run transcript and appear in the Agent Panel. No Rust or agent-core-v3 changes.

* **Recurring DOCX refresh** — a run can select an editable DOCX from its existing working set and inspect another DOCX as a read-only source. Selection reuses the active binding, keeps complete working-set context through the switch, and is blocked after edits so one run still saves one edited version. No Rust or agent-core-v3 changes.

* **Telemetry terminology cleanup** — compact `[agent-run-report]` log uses `toolCalls` / `readCalls` / `mutationCalls` / `editsApplied` / `persistedVersions` / `toolErrors` (not ambiguous `edits`/`versions`/`failures`). Recovered tool attempts log as `[agent-run-tool-error]`; `outcome` remains authoritative for terminal run failure. `AgentRunReport.failures` kept for Cloud JSON compatibility. Product completion headline is `Updated document · 19s` (no accidental activity-row “actions” count). Vocab note in `docs/agent_core.md`. No engine / agent-core-v3 / Cloud behavior change.

* **Table-cell text formatting** — `@opensuitehq/engine` 0.1.2 lets `set_text_formatting` bold/color simple direct-body table cells. Paragraph style/formatting still exclude cells.

* **Silent recovery / polish discipline** — operating instruction: recover tool failures without narrating reason codes/selectors/stale handles; abandon optional cosmetic polish after repeated failure; keep retrying for explicit user requirements or correctness. Final response mentions unresolved limits only when material. Prompt-only; no agent-core-v3 / engine change. Logs and activity Details unchanged.

* **Recoverable-error UX** — activity rows no longer paint provisional `tool.failed` as terminal red. Live recovery keeps Thinking / success rows; details still show attempts (`Recovered · …` when superseded). Only `agent.failed` / run outcome failed stays red (“Couldn't complete”). SSE `error` maps to reason codes for labels. Frontend-only; no engine / agent-core-v3 / API event changes.

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
* **Engine npm cutover** — `@opensuite/engine-client` depends on `@opensuitehq/engine@0.1.2` from npm (not sibling `link:` / vendor stub). Docker `node:22-bookworm-slim` (glibc) was validated with 0.1.1; Alpine/musl unsupported.
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

* Readable full-trace aggregation: 9 focused run-trace tests; API typecheck and `git diff --check` pass. No paid model call or commit.

* Phase 2 human-turn correction: API/V3 typechecks and `git diff --check` pass. Focused checks in existing files cover coherent historical pairs, a completed reply alongside a failed run without one, and finish-only text retention. Functional behavior awaits manual full tracing. No paid model call or commit.

* Current-document continuity: 7 focused API regressions plus full API 333 tests (313 passed, 20 DB integration tests skipped); V3 38 tests; API/V3 typechecks and `git diff --check` pass. Real Rust + fake-model coverage checks lazy batched refresh, no-edit reuse, stale handles/fresh inspect, unchanged sources, current table selectors, limits/completeness/recovery, one final save, no storage reads during refresh, and traced/untraced behavior. Two tiny-document refreshes measured 0.21–0.27 ms locally. No paid model call or commit.

* Clarification: 84 focused API lifecycle/execution/tool-surface/policy/trace tests; full API 326 tests (306 passed, 20 DB integration tests skipped); 49 focused web message/progress tests; V3 37 tests; API build, API/web/V3 typechecks and `git diff --check` pass. Real Rust plus fake-model checks cover unchanged bytes/no version, earlier-edit preservation, question SSE/persistence/trace, and normal follow-up edits. No paid model call or commit.

* Local full run traces: 9 focused writer/runtime trace tests plus API retrieval/save/validation/setup-error/cancellation coverage; full API suite 323 tests (303 passed, 20 DB integration tests skipped); V3 37 tests; API/V3 typechecks and `git diff --check` pass. Traced/untraced mocked requests, events, tool execution, outcomes and deterministic metrics match. No paid model call or commit.

* Dynamic tool surface: V3 typecheck + 36 tests; API typecheck/build, 106 focused tests, full 313 tests (293 passed, 20 DB integration tests skipped), and `git diff --check` pass. Real Rust + fake-model integration covers loading, handle reuse/expiry, finish containment and one saved version; a recurring-update regression completes all six required tool calls with zero discovery turns. No paid model call.

* Phase 1 same-turn handles: real scheduler + Rust binding regressions cover three-table presentation, all seven allowed formatting operations, structural/content invalidation, old-turn stale handles, genuine failure, and partial saves. API build/typecheck, 73 focused API tests, full 306-test suite (286 passed, 20 DB integration tests skipped), V3 typecheck and 33 tests, engine-client 13 tests, and `git diff --check` pass. No paid model call; DeepSeek dogfood remains the next check.

* Live DOCX preview after blank creation: web typecheck, 41 focused preview/activity tests, and `git diff --check` pass. User-run Luna check is still needed to verify editor behavior in the browser.

* Blank-document STALE_HANDLE fix: focused version/lifecycle/operating-instruction tests, API build/typecheck, and `git diff --check` pass. No paid model call after the fix; manual Luna rerun awaits user testing.

* Agent action follow-up: agent-core-v3 typecheck and 31 tests; API typecheck, full 295-test suite (275 passed, 20 skipped), and focused operating-instruction tests (10) pass; `git diff --check` passes. No paid model call in this pass.

* Phase A reasoning-budget follow-up: captured installed adapter requests with a fake fetch (no paid model call). The former capped request was `max_tokens: 8192` and `reasoning: { effort: "low" }`; the adapter can serialize `reasoning: { max_tokens: 4096 }`, but model support for an exact budget is not advertised. Core 31 tests, focused API 74 tests, API typecheck, and `git diff --check` pass. No reasoning budget was added.

* Agent runtime reliability Phase A: agent-core-v3 typecheck and 31 tests; API typecheck, 74 focused tests, and full 295-test suite (275 passed, 20 skipped); `git diff --check` pass. No paid model call in that pass.

* Final cleanup: API build/typecheck, web and agent-core-v3 typechecks, 85 focused API tests, and `git diff --check HEAD` pass. No paid model call.

* Cleanup Phase 5B: `run-manager.repair` (4) + working-document route (1) + execution.isolation (38), API typecheck, `git diff --check` pass. No behavior change intended.

* Cleanup Phase 5A: `api-client` + `api-base-url` tests (8), web typecheck, `git diff --check` pass. AI/storage feature tests still hit pre-existing Node strip-types extensionless-import failures when loading the module graph; shared transport covered by `api-client.test.ts`.

* Cleanup Phase 4B: web agent-progress/messages/markdown/prompt-attachments tests (54), web typecheck, `git diff --check` pass. No behavior change intended.

* Cleanup Phase 4A: web agent-progress/messages/markdown tests (51), web typecheck, `git diff --check` pass. No behavior change intended.

* Cleanup Phase 3B: API focused lifecycle/isolation/version/report/retrieval/projection/operating-instruction tests (133), API typecheck, `git diff --check` pass. Restored `workspace_retrieval_skipped` summarizeError sanitization. No behavior change intended.

* Cleanup Phase 3A: API focused agent context/retrieval/isolation/version/report/operating-instruction tests (127), API typecheck, `git diff --check` pass. No behavior change intended.

* Cleanup Phase 2: web focused (65), API agent-run-log/report (20), web+api+engine-client typechecks, `git diff --check` pass. No behavior change intended.

* Cleanup Phase 1: web agent-progress/theme-model/open-tabs tests (40), API context-projection tests (9), web+API typechecks, `git diff --check` pass. No behavior change intended.

* Agent latency pass: focused V3 and API tests/typechecks pass; no paid model benchmark or manual dogfood run yet.

* Agent tool ergonomics: 40 focused API operating-instruction, retrieval, and mutation tests pass; API TypeScript build/typecheck passes. No model or browser test.

* Linux deployment-image check: existing `node:22-bookworm-slim` API Dockerfile built on Colima linux/arm64; npm installed `@opensuitehq/engine-linux-arm64-gnu@0.1.2`. Native load, DOCX inspect, structural formatting of two header cells, output re-inspection, and API capability-gated tool exposure passed. No product test or production change.

* Engine 0.1.2 integration and table selectors: 31 focused API tests and 9 focused engine-client tests pass; API and engine-client typechecks pass. Real binding confirms capability gating, multi-cell formatting, stale handles, duplicate-header selector round trip, and unchanged multi-document retrieval. No manual test.

* Fix pass 2: 71 focused API verification, lifecycle, isolation, and report tests passed. Generic-edit reconciliation regression: 51 focused API tests and API typecheck pass. No manual test.

* Fix pass 1: focused API retrieval/policy/lifecycle tests and web progress tests pass; API, DB, and web typechecks pass. No manual product test.

* Phase 3 fix: focused API verification, lifecycle, and run-report tests pass; API build passes. No manual browser test.

* Continue presentation: 48 focused web tests pass; web typecheck and production build pass. No manual browser test.

* Document verification and V3 lifecycle focused tests: 39 pass; API build and web typecheck pass. No manual browser test for this phase.

| Check | Status |
|---|---|
| Brand palette: web typecheck; all 5 palettes swap live (CDP: app + landing, light/dark); no leftover blue under BROWN across 14 public pages + agent fixture | Pass (no logged-in `/app` visual, no `next build`) |
| Public marketing + auth UI copy-over; web typecheck + `next build` | Pass |
| Readable agent run logs (API formatters + report + isolation; core-v3 lifecycle) | Pass (60 API focused: log 5 + report 20 + isolation 35) |
| agent-core-v3 unit (26) | Pass |
| API unit (221; 20 skipped) | Pass |
| Model accounting live OpenRouter E2E | Pass (`availableEvidenceTokens`, ctx=1048576, actual cost) |
| Context lifecycle C1–C7 targeted API checks | Pass |
| Phase 6A API retrieval + lifecycle/report tests (22) | Pass |
| Phase 1 workspace retrieval API tests | Pass |
| engine-client tests (13) | Pass (npm `@opensuitehq/engine@0.1.2` + darwin-arm64) |
| web agent-progress recoverable-error UX | Pass (32) |
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
| operating-instruction silent recovery / polish | Pass (focused) |
| Telemetry terminology (report log + UI headline) | Pass (API report 15; web agent-progress 32) |

## Intentionally Deferred

* Delete agent-core-v2; Phase 4 request context
* Rename/move/delete/folder tools; multi-document inspect
* Finish-as-read scheduling redesign
* AgentRunReport developer dashboard

## Recommended Next Step

Re-run a local `AGENT_RUN_TRACE=full` document edit and confirm the Markdown is turn-scoped (one Reasoning / Assistant Text / Tool Calls / Tool Result / Usage block per turn) rather than per-token delta sections.
