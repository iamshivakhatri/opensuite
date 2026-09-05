# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell.
* Agent persistence (DB + service) — no public chat API.
* Agent-core `AgentRunner` (deterministic fake/model loop). **No real LLM.**
* **AgentExecutionService** (`apps/api`) — durable run orchestration via persistence ↔ runner.

## Just Completed

`AgentExecutionService` in `apps/api/src/agent/execution.ts`:

* `execute({ userId, threadId, instruction, signal? })` awaits `AgentRunner` in-process
* Ownership: thread → workspace → owner (non-owned → `THREAD_NOT_FOUND`)
* Atomic start: user `AgentMessage` + `AgentRun(queued)` in one transaction
* Document-scoped threads resolve latest `DocumentRef` (id/version/format); no version rows created
* Conversation context = prior persisted user/assistant messages + current instruction (no dup)
* Event bridge persists meaningful steps (tool/confirmation); in-memory sequence per run
* Partial success: failed tools keep run `completed` when runner succeeds
* Cancel → run `cancelled`; failure → run `failed` + safe error fields; no fake assistant
* Empty runner summary → no assistant message
* Confirmation: inject gate (tests use `AutoApproveConfirmationGate`); no gate → deny destructive
* No HTTP/SSE/jobs/real LLM/Rust/Office tools

## Current Decisions

* Dangerous confirmation is opt-in (`AutoApproveConfirmationGate`); default deny.
* Steering stays in-memory (`InMemorySteeringQueue`); durable wait/resume deferred.
* Step sequence owned by the in-process event adapter (not distributed).

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` unit tests | **Pass** |
| `contracts` / `db` / `engine-client` / `api` typecheck + tests | **Pass** |
| `apps/web` typecheck + `next build` | **Pass** |

## Intentionally Deferred

* Chat HTTP, SSE, frontend Agent panel
* Real providers, Office tools, engine mutate/render
* Durable confirmation resume / cross-request steering
* Background job queues

## Recommended Next Step

Minimal Fastify agent endpoint that calls `AgentExecutionService` (still FakeAgentModel).
