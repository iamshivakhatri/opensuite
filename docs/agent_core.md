# OpenSuite Agent Core

OpenSuite owns its agent-core (`packages/agent-core`) — a small, Office-native
runtime inspired by Pi Agent Core ideas (stateful execution, tools, events,
steering, cancellation, provider-independent models, tool policies), not a
Pi fork or coding-agent clone.

## Product model (Cursor-style task executor)

* Acts immediately by default — no plan-approval gate for normal edits
* Destructive tools require confirmation (via tool `risk: "destructive"`)
* Concise progress via events; hidden chain-of-thought is not normal UI
* Assistant text streams via `message.delta` when the model adapter supports it
* Partial success survives — later failures do not erase earlier tool outcomes
* One primary document initially; architecture leaves room for multi-doc later
* Immutable document versions/checkpoints live in the **application** layer

## AgentRunner (deterministic loop)

```text
AgentRequest
  → AgentModel
  → 0..N tool calls
  → ToolRegistry / AgentTool (DocumentRuntime inside tools)
  → tool observations on transcript
  → AgentModel …
  → AgentResult
```

### OpenSuite policy boundaries (AgentRunner v2 Steps 3–5C)

`AgentRunner` is domain-agnostic for tools and document state:

* Calls injected `TurnToolSelector` (`turn-tools.ts`) once per turn — context
  is only `{ toolOutcomes, signal }` (no `DocumentRef`).
* Calls injected `CreateToolExecutionContext` once **per tool execution** —
  does not construct or interpret document fields on the context.
* Calls injected `TransformAgentContext` immediately before each
  `model.complete` — owns *when* model context is prepared; does not own
  OpenSuite/document projection policy. Default is identity.
* Does **not** own document run state, runtime/mutation services, tool names,
  write detection, terminalization rules, authoring timeout guidance, or
  model-context projection.
* Calls an injected generic tool-batch predicate after execution; OpenSuite
  decides whether successful writes plus assistant content may finish the run.
* On model timeout, an injected policy may supply one retry message; the runner
  runtime owns the timer and one-retry limit but does not interpret authoring
  state.
* Generic `executeModelTurn` owns model-facing transformation timing, tool
  request preparation, timeout/abort mechanics, streaming message events,
  model metrics, and normalized model-turn results. `AgentRunner` retains the
  canonical transcript and outer model/tool loop.

OpenSuite document runs wire these via `createDocumentAgentRunnerOptions` /
`createDocumentAgentRunnerPolicyOptions` (selector + per-tool context +
`transformContext` from `model-context.ts` + terminalization/timeout
nudges). The selector closes over `state.primary` for capability discovery;
the context factory reads the same state fresh each call so sequential
writes observe N→N+1→N+2.

### Document tools

Implementation lives in `packages/agent-core/src/document-tools/`:
`define-tool` (descriptor + capability/mutation plumbing), `shared-schema`,
`selectors`, `inspect`, `mutations`, `run-state`, `turn-tool-selector`.
Individual typed tools stay model-visible; DOCX writes share
`executePersistedMutation` (immutable N→N+1, no advance on failure).

**Capability-driven discovery (run bootstrap, before first model call)**

```text
primary DocumentRef (OpenSuite run state)
  → DocumentRuntime.capabilities(...)
  → filter documentToolCatalog by requireCapability
  → merge with non-document tools
  → first model.complete
```

* Each document tool declares `capability` / `requireCapability` on its descriptor.
* Runtime capability ids are the sole availability source — no `if (format === "docx")` tool switches.
* Discovery is memoized by primary `documentId` in `createDocumentTurnToolSelector`; N→N+1 does not re-discover; create that changes document identity does.
* Discovery failure → run fails with `CAPABILITY_DISCOVERY_FAILED` (does not expose all tools / mock DOCX caps).
* Model-facing catalog is capability-filtered only — `document.capabilities` is **not** model-facing (internal factory remains for tests).
* PPTX/XLSX mock runtimes advertise format-specific caps (`slides.update_text`, `workbook.set_cells`).
* **Version-bound handles:** `ArtifactHandleRegistry` lives on OpenSuite `DocumentRunState` (handle → versionId). `document.inspect`
  registers opaque `handle` strings from the payload; handle-bearing mutations validate via
  `requireCurrentArtifactHandles` before Rust. `STALE_HANDLE` / `UNKNOWN_HANDLE` — no version UUIDs to the model.

**Read**

* `document.inspect` — DOCX: `overview` / `headings` / `paragraphs` / `tables` / `body_blocks` / `context` (paged); PPTX/XLSX mock: slides/sheets/range.
  Inspected objects may optionally carry format-neutral `affordances[]` (engine-authored; absence ≠ supported/unsupported).
  Failed mutations may carry structured diagnostics (`code` + optional `reasonCode` / `operation` / `targetHandle`);
  prefer those fields over parsing `message`. Application errors (`STALE_HANDLE` / `UNKNOWN_HANDLE`) stay separate.
* `document.find` — text or semantic matches

**Safe writes**

* `document.replace_text` — DOCX prose/heading find/replace; **tool success = persisted immutable version**
* `document.insert_paragraph` — create one paragraph at start|end|before|after body-block handle; capability `insert_paragraph`
* `document.insert_paragraphs` — atomic multi-paragraph insert (same placement); prefer for consecutive known prose; capability `insert_paragraphs`
* `document.delete_paragraph` — delete by semantic text target; capability `delete_paragraph`
* `document.set_paragraph_style` — set/clear style display name (e.g. Heading 1); capability `set_paragraph_style`
* `document.set_paragraph_formatting` — alignment / spacing (twips); capability `set_paragraph_formatting`
* `document.set_text_formatting` — bold/italic/font size/family; capability `set_text_formatting`
* `document.create_table` — atomic rectangular matrix + body placement; prefer when initial contents known; capability `create_table`
* `document.set_table_cells_text` — atomic multi-cell update (semantic labels **or** opaque cell handles from inspect)
* `document.insert_table_rows` — contiguous multi-row insert after semantic row label **or** row handle
* `document.insert_table_column` — single column insert after semantic header **or** column handle
* `document.delete_table` / `document.delete_table_row` / `document.delete_table_column` — structural deletes; capability ids match
* `slides.update_text` — PPTX slide title or existing→new text (mock runtime path)
* `workbook.set_cells` — XLSX small cell writes (mock runtime path)

`DocumentRef` always comes from `ToolExecutionContext.primaryDocument` — never from model input.
DOCX writes use injected `DocumentMutationExecutor` (not bare `runtime.execute`).
Agent-core does **not** own DB/storage; apps/api injects `apply*` including paragraph + table lifecycle apply methods.

After a persisted mutation, the run advances its active `DocumentRef` N → N+1
(run-local only). Subsequent find/inspect/mutate in the **same run** read N+1.
`executePersistedMutation` emits `document.version.advanced` for SSE/UI refresh.
Raw `artifactBytes` alone is **not** tool success.

Write tools use `effect: "write"` and `executionMode: "sequential"`.
Table/paragraph tools are gated on Rust capability ids.

Default product stack: `createMockDocumentRuntime({ capabilities: mutableDocumentCapabilities() })`.
Real DOCX path: `createOpenSuiteEngineAdapter` — caps/find/inspect + paragraph authoring + full table lifecycle via N-API
(see `docs/engine_integration.md`). No mock fallback for unsupported real-DOCX focuses (e.g. slides).
Inspect paging uses `offset`/`limit` (default 20, max 100). Occurrence/order is version-local only.

Body placement: inspect(`body_blocks`) → `insert_paragraph(s)` / `create_table` before/after opaque handle → re-inspect after N+1.
Prefer `insert_paragraphs` / `create_table` for multi-block creation (one version); compose style/formatting afterward.
Table workflow: create_table (or inspect existing) → typed table mutation → immutable version → re-inspect.
Semantic selectors (rowLabel/columnHeader/headerCells) are human-readable convenience.
Opaque structural handles from inspect are exact artifact-local targets for blank/duplicate/awkward cells —
never persist them; re-inspect after any version-changing edit before reuse.
Capability does not guarantee every structure is writable (merged/complex may return `UNSUPPORTED_OPERATION`).
Not exposed: table styling, merged cells, multi-column insert batch, lists/images, legacy `insert_paragraph_after` model tool, generic `document.mutate`.
Blank DOCX create is application/API → engine-client `createBlankDocx` → Version 1 — outside AgentRunner.

Persisted mutation results include `document` (new DocumentRef), `baseVersionId`, optional `change`
summary — never storage keys or engine source identities.

System instruction: `buildDocumentAgentSystemPrompt(capabilities)` — behavioral only; adapters must
pass the run's discovered capabilities so mutate/authoring guidance matches the filtered tool catalog.
Prefer fewest **model rounds** (batch independent writes in one assistant response). Blank docs need
no ritual inspect before append/end authoring. Structured `reasonCode` over message parsing; no blind retries.
Canonical transcript stays rich; `transformContext` projects slim model-facing tool results
(no echoed prose / version UUIDs; inspect drops empty caps/null summary/format duplication)
and compacts large historical successful write tool arguments for later
provider turns (id/name/pairing preserved). When an assistant response includes a short
Done confirmation **plus** successful document writes, OpenSuite policy may terminalize without
a third final-answer-only model call (read-only / failed / confirmation batches never do).
`model.turn.metrics` / `tool.execution.metrics` provide lightweight run observability.
Developer benchmark: `pnpm agent:bench` (PROVIDER/MODEL/SCENARIO overrides) aggregates those
events into `.agent-bench/*.json` — not a product analytics platform.
Never claim an edit succeeded without a successful mutation tool result.

* Safe tools execute immediately; write tools default sequential
* Destructive + `ConfirmationGate` → ask gate; **no gate → deny**
* `priorMessages` (user|assistant) seed the transcript before `instruction`
* `executionMode: parallel-safe | sequential` — consecutive parallel-safe calls
  may run concurrently; sequential (default) is a barrier. No conflict graph.
* Steering (`SteeringSource` / `InMemorySteeringQueue`) injects mid-run user
  corrections before the next model turn. Follow-up = a later separate run.
* Cancellation via `AbortSignal` → `agent.cancelled` (not a generic failure)
* `maxTurns` (default 20) → `MAX_TURNS_EXCEEDED` with outcomes preserved
* Internal `ModelMessage` transcript includes `user` / `assistant` / `tool`

No PostgreSQL, SSE, provider SDKs, or Rust engine inside agent-core.

## Application orchestration (`AgentExecutionService`)

Lives in `apps/api` (not agent-core):

```text
start(user instruction)
  → verify owned thread
  → tx: append user message + create run(queued)
  → return handle immediately
  → (async) capability-discover document tools + AgentRunner + event→step bridge + finalize
```

* `execute()` = `start()` then await `handle.result` (tests / sync callers)
* Optional `liveEvents` sink fans out after persistence bridge (SSE hub)
* Parallel tools: per-run in-memory sequence counter; start-order sequences
* Tool step failure ≠ run failure; runner `completed` → run `completed`
* Cancel → `cancelled`; model failure → `failed` + safe error fields
* When `tools` omitted: `createDocumentAgentRunnerOptions` (selector + per-tool context over OpenSuite run state)

## Live runs (`AgentRunManager` + HTTP)

```text
POST /runs → 202 { run }
  → AgentRunManager tracks active run + event hub
GET /runs/:id → durable snapshot
GET /runs/:id/events → SSE (live ordered events; heartbeat comments)
```

* Multi-subscriber; disconnect unsubscribes (does not cancel the run)
* After terminal + short grace, hub is dropped — history via GET /runs
* **API process restart abandons in-memory runs** (no Redis/workers yet)
* Hijacked SSE sets CORS headers manually (`reply.hijack` bypasses `@fastify/cors`)

## HTTP API (Fastify)

* `POST /api/documents/:documentId/agent/threads`
* `GET /api/documents/:documentId/agent/threads`
* `GET /api/agent/threads/:threadId`
* `GET /api/agent/threads/:threadId/messages` (+ `latestRun`)
* `POST /api/agent/threads/:threadId/runs` → **202** queued run
* `GET /api/agent/runs/:runId`
* `POST /api/agent/runs/:runId/cancel`
* `GET /api/agent/runs/:runId/events` → SSE

Inject model/tools via `buildApp` deps / `createConfiguredAgentModel(config)`.
`AGENT_MODEL_PROVIDER=unconfigured|fake|anthropic|openai|openrouter`
(fake banned in production; OpenRouter requires explicit `OPENROUTER_MODEL`).
Provider SDKs/adapters live in `apps/api` — not agent-core.
Document workspace Agent panel is wired.

## Boundaries

Agent Core owns: messages, model boundary, tools/registry/policy, events,
DocumentRuntime contracts, AgentRunner, diagnostics/errors, AbortSignal,
steering/confirmation interfaces, mock working copies.

Agent Core does NOT own: auth, DB, storage, HTTP/UI, Office XML/OPC/NodeId,
provider SDKs, durable document versions.

## Persistence independence

Durable history is application-owned. `AgentExecutionService` maps selected
`AgentEvent`s → `AgentStep` / run status. Agent-core must not import that layer.

## Intentionally deferred

* Delete row/column, create table, multi-column insert; PPTX/XLSX engine runtimes
* Model routing-fallback / durable confirmation resume / Redis workers
* Semantic conflict detection for parallel mutations
