# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell.
* Agent persistence + **AgentExecutionService** + **AgentRunManager** (live in-process).
* Agent-core `AgentRunner` (deterministic fake/model loop). **No real LLM.**
* Authenticated agent HTTP + **SSE** + document Agent panel (end-to-end).

## Just Completed

Document Agent panel wired end-to-end (still FakeAgentModel via DI in tests):

* `GET /api/documents/:documentId/agent/threads` — owned document threads (newest first)
* `POST /api/agent/runs/:runId/cancel` — abort in-process run; terminal idempotent; 404 non-owned
* Panel: reuse latest non-archived document thread; lazy-create on first submit
* Composer → 202 run → SSE Cursor-style progress → refresh messages/snapshot
* Stop action; SSE disconnect recovers via `GET /runs/:id` (does not cancel)
* `GET …/messages` also returns `latestRun` for refresh recovery of active runs

## Current Decisions

* Document-first threads; sync start + async execution (no job workers).
* Durable recovery = AgentRun/AgentStep rows (+ `latestRun` on messages), not an event log.

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` unit tests | **Pass** |
| `contracts` / `db` / `engine-client` typecheck | **Pass** |
| `api` typecheck + unit + DB integration tests | **Pass** |
| `apps/web` typecheck + progress unit tests + `next build` | **Pass** |

## Intentionally Deferred

* Real LLM providers, Office tools, Rust engine
* Durable event log, Redis/BullMQ/workers, confirmation resume API
* Workspace-level agent threads

## Recommended Next Step

Inject a local FakeAgentModel (or first real provider) for manual panel QA, then Office inspect tools.
