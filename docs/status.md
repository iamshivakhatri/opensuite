# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell.
* Agent persistence + **AgentExecutionService** (durable Thread → Message → Run → Step).
* Agent-core `AgentRunner` (deterministic fake/model loop). **No real LLM.**
* **Authenticated agent HTTP API** (sync runs; no SSE/frontend yet).

## Just Completed

Fastify agent routes (`apps/api/src/routes/agent.ts`):

* `POST /api/documents/:documentId/agent/threads` — document-scoped thread
* `GET /api/agent/threads/:threadId`
* `GET /api/agent/threads/:threadId/messages` — user/assistant only
* `POST /api/agent/threads/:threadId/runs` — await `AgentExecutionService.execute`
* Ownership: session user; non-owned → 404; unauthenticated → 401
* Composition injects model/tools via `AppDependencies.agent` (routes never build FakeAgentModel)
* Production default model = unconfigured stub until a real provider is wired
* Destructive tools deny-by-default (no confirmation gate in default wiring)
* Client disconnect aborts the in-flight run when the socket closes

## Current Decisions

* Document-first threads only (no workspace-level agent API yet).
* Sync POST run (no job queue / SSE).
* Dangerous confirmation remains opt-in for tests only.

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` unit tests | **Pass** |
| `contracts` / `db` / `engine-client` / `api` typecheck + tests | **Pass** |
| `apps/web` typecheck + `next build` | **Pass** |

## Intentionally Deferred

* SSE / streaming, frontend Agent panel
* Real providers, Office tools, engine mutate/render
* Durable confirmation resume, run-list endpoints, job queues

## Recommended Next Step

SSE (or similar) progress events for an in-flight run, still on FakeAgentModel.
