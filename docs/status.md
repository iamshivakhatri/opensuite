# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell.
* Agent persistence + **AgentExecutionService** + **AgentRunManager** (live in-process).
* Agent-core `AgentRunner` (deterministic fake/model loop). **No real LLM.**
* Authenticated agent HTTP + **SSE** for live run progress.

## Just Completed

Live agent runs:

* `POST /api/agent/threads/:threadId/runs` → **202 `{ run }`** after durable queued run; execution continues in-process
* `GET /api/agent/runs/:runId` → durable run + steps snapshot
* `GET /api/agent/runs/:runId/events` → SSE (`text/event-stream`) of meaningful live events
* `AgentRunManager` hubs ordered events, multi-subscriber, grace cleanup after terminal
* `AgentExecutionService.start()` returns after message+run persist; `execute()` still awaits full result
* SSE is live-only; reconnect after hub eviction uses GET /runs (or a terminal SSE hint)
* **Process restart loses in-memory execution** — no Redis/queues yet
* Destructive tools still deny-by-default; no frontend / real LLM / engine

## Current Decisions

* Document-first threads; sync start + async execution (no job workers).
* Durable recovery = AgentRun/AgentStep rows, not an event log.

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` unit tests | **Pass** |
| `contracts` / `db` / `engine-client` / `api` typecheck + tests | **Pass** |
| `apps/web` typecheck + `next build` | **Pass** |

## Intentionally Deferred

* Frontend Agent panel, real providers, Office tools, Rust engine
* Durable event log, Redis/BullMQ/workers, confirmation resume API

## Recommended Next Step

Wire the document workspace Agent panel to thread/run/SSE (still FakeAgentModel).
