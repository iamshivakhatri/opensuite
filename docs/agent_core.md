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
execute(user instruction)
  → verify owned thread
  → tx: append user message + create run(queued)
  → resolve DocumentRef (latest version) when document-scoped
  → AgentRunner + event→step bridge
  → tx: assistant message (if non-empty summary) + finalize run
```

* Maps `tool.*` / `confirmation.required` → durable `AgentStep` (not every event)
* Parallel tools: per-run in-memory sequence counter; start-order sequences
* Tool step failure ≠ run failure; runner `completed` → run `completed`
* Cancel → `cancelled`; model failure → `failed` + safe error fields
* Durable confirmation resume deferred

## HTTP API (Fastify)

Document-scoped, authenticated, synchronous:

* `POST /api/documents/:documentId/agent/threads`
* `GET /api/agent/threads/:threadId`
* `GET /api/agent/threads/:threadId/messages`
* `POST /api/agent/threads/:threadId/runs` → awaits execution, returns durable run/messages/steps

Inject model/tools (or full execution service) via `buildApp` deps — not FakeAgentModel in route handlers. Default production model is an unconfigured stub. No SSE, no frontend Agent panel, no real LLM yet.

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
* Durable confirmation resume / SSE
* Semantic conflict detection for parallel mutations
* Engine mutate/serialize/render adapters
* Frontend Agent panel wiring
