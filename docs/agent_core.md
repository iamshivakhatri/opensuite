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

**Read**

* `document.capabilities` — list runtime caps for the primary document
* `document.inspect` — targeted focus (`overview` / `headings` / `slides` / `sheets` / `range` / …)
* `document.find` — text or semantic matches

**Safe writes (mock)**

* `document.replace_text` — DOCX find/replace in headings/paragraphs
* `slides.update_text` — PPTX slide title or existing→new text
* `workbook.set_cells` — XLSX small cell writes

`DocumentRef` always comes from `ToolExecutionContext.primaryDocument` — never from model input.
Tools pass `runId` into `DocumentRuntimeOptions` so the runtime can keep a **run-scoped working copy**.
Immutable base fixtures / DocumentRef are never mutated in place.

Write tools use `effect: "write"` and `executionMode: "sequential"`.
Format-filtered registration: DOCX runs do not receive workbook/slide tools (and vice versa).

Default product stack: `createMockDocumentRuntime({ capabilities: mutableDocumentCapabilities() })`.
Real DOCX path: `createOpenSuiteEngineAdapter` — capabilities/find(text)/inspect(context)/replace_text via N-API
(see `docs/engine_integration.md`). No mock fallback for unsupported real-DOCX focuses.
Mutation success may include `artifactBytes`; persistence stays in the application layer.
Mutation results include a small `change` summary (`operation`, `area`, `before`, `after`) — not a durable diff/version system.

System instruction: `buildDocumentAgentSystemPrompt` — capability-driven:
mutate advertised → may edit with tools + must verify; otherwise say edits unavailable.
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
  → (async) format-filtered tools + AgentRunner + event→step bridge + finalize
```

* `execute()` = `start()` then await `handle.result` (tests / sync callers)
* Optional `liveEvents` sink fans out after persistence bridge (SSE hub)
* Parallel tools: per-run in-memory sequence counter; start-order sequences
* Tool step failure ≠ run failure; runner `completed` → run `completed`
* Cancel → `cancelled`; model failure → `failed` + safe error fields

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

* Broad engine inspect (overview/headings/tables); PPTX/XLSX engine runtimes
* Broad engine inspect (overview/headings/tables); more mutations; agent auto-persist
* Model routing-fallback / durable confirmation resume / Redis workers
* Semantic conflict detection for parallel mutations
