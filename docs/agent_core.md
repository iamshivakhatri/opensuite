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

* Safe tools execute immediately; destructive tools use `ConfirmationGate`
* `executionMode: parallel-safe | sequential` — consecutive parallel-safe calls
  may run concurrently; sequential (default) is a barrier. No conflict graph.
* Steering (`SteeringSource` / `InMemorySteeringQueue`) injects mid-run user
  corrections before the next model turn. Follow-up = a later separate run
  (not implemented).
* Cancellation via `AbortSignal` → `agent.cancelled` (not a generic failure)
* `maxTurns` (default 20) → `MAX_TURNS_EXCEEDED` with outcomes preserved
* Internal `ModelMessage` transcript includes `user` / `assistant` / `tool`
  (broader than DB `agent_message` user|assistant)

No PostgreSQL, SSE, provider SDKs, or Rust engine inside agent-core.

## Boundaries

Agent Core owns: messages, model boundary, tools/registry/policy, events,
DocumentRuntime contracts, AgentRunner, diagnostics/errors, AbortSignal,
steering/confirmation interfaces.

Agent Core does NOT own: auth, DB, storage, HTTP/UI, Office XML/OPC/NodeId,
provider SDKs.

## Persistence independence

Durable history remains application-owned. Orchestration later maps
`AgentEvent` → AgentStep / SSE. Agent-core must not import that layer.

## Intentionally deferred

* Real LLM providers and Office tools
* Durable confirmation resume / chat HTTP / SSE
* Semantic conflict detection for parallel mutations
* Engine mutate/serialize/render adapters
