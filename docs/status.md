# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, Office upload/list/download, Files UI, document workspace shell.
* Agent persistence: `agent_thread` → `agent_message` / `agent_run` → `agent_step` + `apps/api/src/agent/persistence.ts` (no public chat API).
* **Agent-core foundation (this milestone):** contracts + interfaces in `packages/agent-core` — model/tool/event/runtime boundaries, fakes, unit tests. **No agent loop yet.**

## Just Completed

`@opensuite/agent-core` durable TypeScript contracts:

* `AgentRequest` / `AgentRunContext` / runtime `AgentMessage` / `AgentResult` / `SteeringMessage`
* `AgentModel` + `ToolRegistry` / `AgentTool` (`risk: safe|destructive`) + `AbortSignal` on execute/model
* `AgentEvent` discriminated union + `AgentEventSink`
* `DocumentRuntime` (capability-based inspect; optional execute) + `DocumentRef` / narrow `SemanticTarget`
* Removed premature `engine-client` dependency from agent-core (runtime adapters come later)

## Current Decisions

* One Agent for all formats; specialization via tools + capabilities + format payloads.
* Engine `NodeId` / XML / OPC forbidden in agent-core contracts.
* Partial success: tool outcomes may mix succeeded + failed; no whole-run rollback assumption.
* Immediate action by default; destructive tools flag confirmation — UI/orchestration later.

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` typecheck/build + 13 unit tests | **Pass** |
| `contracts` / `db` / `engine-client` / `api` typecheck + unit tests | **Pass** |
| `apps/web` typecheck + `next build` | **Pass** |
| Prefer `node …/tsc.js` if `pnpm`/`turbo` wrappers hang (leftover watchers) | noted |
## Intentionally Deferred

* Agent runner loop, real tools, LLM providers, confirmation workflow
* Chat/agent HTTP + SSE; persistence↔event bridge
* Engine mutate/serialize/render; canvas preview

## Recommended Next Step

Implement a **minimal AgentRunner loop** over these contracts (FakeAgentModel + fake tools), then application orchestration that persists events/steps — still before public chat API if preferred.
