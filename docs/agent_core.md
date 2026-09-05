# OpenSuite Agent Core

OpenSuite owns its agent-core (`packages/agent-core`) — a small, Office-native
runtime inspired by Pi Agent Core ideas (stateful execution, tools, events,
steering, cancellation, provider-independent models, tool policies), not a
Pi fork or coding-agent clone.

## Product model (Cursor-style task executor)

* Acts immediately by default — no plan-approval gate for normal edits
* Destructive tools require confirmation (via tool `risk: "destructive"`)
* Concise progress via events; hidden chain-of-thought is not normal UI
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

* Safe tools execute immediately
* Destructive + `ConfirmationGate` → ask gate; **no gate → deny** (opt-in approve via
  `AutoApproveConfirmationGate` for tests/local only)
* `priorMessages` (user|assistant) seed the transcript before `instruction`
* `executionMode: parallel-safe | sequential` — consecutive parallel-safe calls
  may run concurrently; sequential (default) is a barrier. No conflict graph.
* Steering (`SteeringSource` / `InMemorySteeringQueue`) injects mid-run user
  corrections before the next model turn. Follow-up = a later separate run.
* Cancellation via `AbortSignal` → `agent.cancelled` (not a generic failure)
* `maxTurns` (default 20) → `MAX_TURNS_EXCEEDED` with outcomes preserved
* Internal `ModelMessage` transcript includes `user` / `assistant` / `tool`
  (broader than DB `agent_message` user|assistant)

No PostgreSQL, SSE, provider SDKs, or Rust engine inside agent-core.

## Application orchestration (`AgentExecutionService`)

Lives in `apps/api` (not agent-core):

```text
start(user instruction)
  → verify owned thread
  → tx: append user message + create run(queued)
  → return handle immediately
  → (async) AgentRunner + event→step bridge + finalize
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

## HTTP API (Fastify)

* `POST /api/documents/:documentId/agent/threads`
* `GET /api/agent/threads/:threadId`
* `GET /api/agent/threads/:threadId/messages`
* `POST /api/agent/threads/:threadId/runs` → **202** queued run
* `GET /api/agent/runs/:runId`
* `GET /api/agent/runs/:runId/events` → SSE

Inject model/tools via `buildApp` deps. Default production model = unconfigured stub.
No frontend Agent panel / real LLM yet.

## Boundaries

Agent Core owns: messages, model boundary, tools/registry/policy, events,
DocumentRuntime contracts, AgentRunner, diagnostics/errors, AbortSignal,
steering/confirmation interfaces.

Agent Core does NOT own: auth, DB, storage, HTTP/UI, Office XML/OPC/NodeId,
provider SDKs.

## Persistence independence

Durable history is application-owned. `AgentExecutionService` maps selected
`AgentEvent`s → `AgentStep` / run status. Agent-core must not import that layer.

## Intentionally deferred

* Real LLM providers and Office tools
* Durable confirmation resume / durable event log / Redis workers
* Semantic conflict detection for parallel mutations
* Engine mutate/serialize/render adapters
* Frontend Agent panel wiring
