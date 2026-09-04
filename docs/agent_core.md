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

## Boundaries

Agent Core owns:

* messages / run context contracts
* model boundary (`AgentModel`)
* tools / registry / risk policy
* events + event sink
* DocumentRuntime + capabilities
* structured diagnostics / results / typed errors
* cancellation via `AbortSignal`; steering type (queue deferred)

Agent Core does NOT own:

* PostgreSQL / Drizzle / Better Auth
* Fastify / Next / React / storage / MinIO
* provider SDKs (OpenAI/Anthropic/…)
* Office XML, OPC, Rust `NodeId`

## Persistence independence

Durable history is application-owned (`apps/api` + `packages/db`):

```text
AgentThread → AgentMessage | AgentRun → AgentStep
```

Application orchestration will later map `AgentEvent` → steps / SSE.
Agent-core must not import that persistence layer.

## Key contracts

```text
AgentRequest / AgentRunContext
    ↓
AgentModel  ←→  ToolRegistry (AgentTool*)
    ↓
DocumentRuntime (capabilities / inspect / optional execute)
    ↓
(future) engine adapter → opensuite-engine
```

* **AgentModel** — provider-neutral `complete({ messages, tools, signal? })`
* **AgentTool** — stable name, typed parse/execute, `risk: safe | destructive`
* **AgentEvent** — discriminated lifecycle events; sink is `emit(event)` only
* **DocumentRef** — `{ documentId, versionId, format }` only
* **RuntimeCapabilities** — extensible `Set<CapabilityId>` (not a giant boolean bag)
* **SemanticTarget** — opaque `{ documentId, versionId, handle }` (intentionally narrow)

## Application persistence (product layer)

See also status.md. Run/step statuses in DB are application vocabulary;
agent-core events are the runtime vocabulary that orchestration will bridge.

## Intentionally deferred

* Full agent loop / tool scheduler / parallel execution policy
* Real LLM providers, concrete document tools, confirmation UI
* Steering queue, SSE, chat HTTP endpoints
* Full mutation language / format-specific semantic addressing

## Target Execution Loop (future)

```text
intent → inspect → reason → plan → typed engine op → diagnostics
  → render → visual inspection → correct if needed → complete
```
