# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell.
* Agent persistence (DB + service) — no public chat API.
* Agent-core contracts + **AgentRunner v1** (deterministic fake/model loop). **No real LLM.**

## Just Completed

`AgentRunner` execution loop in `packages/agent-core`:

* request → model → 0..N tools → observations → model → `AgentResult`
* `ModelMessage` transcript (`user` | `assistant` | `tool`); `maxTurns` default 20
* `executionMode` parallel-safe vs sequential; `ConfirmationGate`; `InMemorySteeringQueue`
* Partial success: tool failures feed the model; earlier outcomes kept
* Unit tests with FakeAgentModel / fake tools only (no DB/network/Rust/LLM)

## Current Decisions

* Immediate action; destructive tools need confirmation gate (not UI yet).
* Steering ≠ follow-up run; runner only drains in-memory steering mid-run.
* DocumentRuntime used by tools, not called directly by AgentRunner.

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` (30 unit tests) | **Pass** |
| `contracts` / `db` / `engine-client` / `api` typecheck + tests | **Pass** |
| `apps/web` typecheck + `next build` | **Pass** |

## Intentionally Deferred

* Real providers, Office tools, chat HTTP, SSE, persistence↔event bridge
* Engine mutate/render; durable confirmation waiting

## Recommended Next Step

Application orchestration: map AgentRunner events → AgentStep persistence, then a minimal Fastify agent endpoint (still FakeAgentModel or stub provider).
