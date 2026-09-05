# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell + Agent panel.
* Agent persistence + **AgentExecutionService** + **AgentRunManager** (live in-process).
* Agent-core `AgentRunner` + **Anthropic AgentModel adapter** (apps/api).
* Authenticated agent HTTP + SSE end-to-end.

## Just Completed

First real model provider (Anthropic) behind existing `AgentModel`:

* `AGENT_MODEL_PROVIDER=unconfigured|fake|anthropic` (+ `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL`)
* `createConfiguredAgentModel(config)` at API composition — routes stay provider-agnostic
* Anthropic Messages adapter: text, 0..N tool calls, tool-result turns, AbortSignal, normalized errors
* `fake` for local/UI QA; **rejected when `NODE_ENV=production`**
* No token streaming; user progress remains AgentEvent/SSE

## Current Decisions

* Document-first threads; sync start + async execution (no job workers).
* Provider SDKs live in `apps/api` adapters — never in agent-core.
* Durable recovery = AgentRun/AgentStep rows (+ `latestRun` on messages).

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` unit tests | **Pass** |
| `contracts` / `db` / `engine-client` typecheck | **Pass** |
| `api` typecheck + unit + DB integration tests | **Pass** |
| `apps/web` typecheck + tests + `next build` | **Pass** |

## Intentionally Deferred

* Office tools / Rust engine / token streaming / other providers
* Durable event log, Redis/BullMQ/workers, confirmation resume API

## Recommended Next Step

Set `AGENT_MODEL_PROVIDER=fake` (or anthropic + key) for panel QA, then add a real document inspect tool.
