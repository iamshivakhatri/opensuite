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

### Document tools

Implementation lives in `packages/agent-core/src/document-tools/`:
`define-tool` (descriptor + capability/mutation plumbing), `shared-schema`,
`selectors`, `inspect`, `mutations`. Individual typed tools stay model-visible;
DOCX writes share `executePersistedMutation` (immutable N→N+1, no advance on failure).

**Capability-driven discovery (run bootstrap, before first model call)**

```text
primary DocumentRef
  → DocumentRuntime.capabilities(...)
  → filter documentToolCatalog by requireCapability
  → merge with non-document tools
  → first model.complete
```

* Each document tool declares `capability` / `requireCapability` on its descriptor.
* Runtime capability ids are the sole availability source — no `if (format === "docx")` tool switches.
* Discovery runs once per AgentRunner run when `documentToolCatalog` is set; N→N+1 does not re-discover.
* Discovery failure → run fails with `CAPABILITY_DISCOVERY_FAILED` (does not expose all tools / mock DOCX caps).
* `document.capabilities` remains model-facing for explicit inspection; it is not required for bootstrap.
* PPTX/XLSX mock runtimes advertise format-specific caps (`slides.update_text`, `workbook.set_cells`).
* **Version-bound handles:** `ArtifactHandleRegistry` (run-local, handle → versionId). `document.inspect`
  registers opaque `handle` strings from the payload; handle-bearing mutations validate via
  `requireCurrentArtifactHandles` before Rust. `STALE_HANDLE` / `UNKNOWN_HANDLE` — no version UUIDs to the model.

**Read**

* `document.capabilities` — list runtime caps for the primary document
* `document.inspect` — DOCX: `overview` / `headings` / `paragraphs` / `tables` / `context` (paged); PPTX/XLSX mock: slides/sheets/range.
  Inspected objects may optionally carry format-neutral `affordances[]` (engine-authored; absence ≠ supported/unsupported).
* `document.find` — text or semantic matches

**Safe writes**

* `document.replace_text` — DOCX prose/heading find/replace; **tool success = persisted immutable version**
* `document.set_table_cells_text` — atomic multi-cell update (semantic labels **or** opaque cell handles from inspect)
* `document.insert_table_rows` — contiguous multi-row insert after semantic row label **or** row handle
* `document.insert_table_column` — single column insert after semantic header **or** column handle
* `slides.update_text` — PPTX slide title or existing→new text (mock runtime path)
* `workbook.set_cells` — XLSX small cell writes (mock runtime path)

`DocumentRef` always comes from `ToolExecutionContext.primaryDocument` — never from model input.
DOCX writes use injected `DocumentMutationExecutor` (not bare `runtime.execute`).
Agent-core does **not** own DB/storage; apps/api injects `applyReplaceText` / `applySetTableCellsText` / `applyInsertTableRows` / `applyInsertTableColumn`.

After a persisted mutation, the run advances its active `DocumentRef` N → N+1
(run-local only). Subsequent find/inspect/mutate in the **same run** read N+1.
Emits `document.version.advanced` for SSE/UI refresh. Raw `artifactBytes` alone
is **not** tool success.

Write tools use `effect: "write"` and `executionMode: "sequential"`.
Table tools are gated on Rust capability ids (`set_table_cells_text`, `insert_table_rows`, `insert_table_column`).

Default product stack: `createMockDocumentRuntime({ capabilities: mutableDocumentCapabilities() })`.
Real DOCX path: `createOpenSuiteEngineAdapter` — caps/find/inspect/replace + table mutations via N-API
(see `docs/engine_integration.md`). No mock fallback for unsupported real-DOCX focuses (e.g. slides).
Inspect paging uses `offset`/`limit` (default 20, max 100). Occurrence/order is version-local only.

Table workflow: inspect(tables) → typed table mutation → immutable version → re-inspect.
Semantic selectors (rowLabel/columnHeader/headerCells) are human-readable convenience.
Opaque structural handles from inspect are exact artifact-local targets for blank/duplicate/awkward cells —
never persist them; re-inspect after any version-changing edit before reuse.
Capability does not guarantee every structure is writable (merged/complex may return `UNSUPPORTED_OPERATION`).
Not exposed: delete row/column, create table, multi-column insert, generic `document.mutate`.

Persisted mutation results include `document` (new DocumentRef), `baseVersionId`, optional `change`
summary — never storage keys or engine source identities.

System instruction: `buildDocumentAgentSystemPrompt` — behavioral only (inspect-before-edit, no retry loops);
the filtered tool catalog communicates which ops exist. Never claim an edit succeeded without a successful mutation tool result.

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
* When `tools` omitted: `documentToolCatalog` → `runtime.capabilities(primary)` once → filtered tools

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
