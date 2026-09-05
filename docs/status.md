# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth, workspaces, documents, Files UI, document workspace shell + Agent panel.
* Agent persistence + **AgentExecutionService** + **AgentRunManager** (live in-process).
* Agent-core `AgentRunner` + multi-provider **AgentModel** adapters in `apps/api`.
* Authenticated agent HTTP + SSE end-to-end.

## Just Completed

Multi-provider AgentModel composition:

* `AGENT_MODEL_PROVIDER=unconfigured|fake|anthropic|openai|openrouter`
* Keys/models: `ANTHROPIC_*`, `OPENAI_*`, `OPENROUTER_*` (`OPENROUTER_MODEL` required, no default)
* Adapters: Anthropic Messages, OpenAI **Responses**, OpenRouter via OpenAI Chat Completions + `https://openrouter.ai/api/v1`
* `createConfiguredAgentModel(config)` — routes stay provider-agnostic
* `fake` rejected in production; tool rejection from OSS models → safe `MODEL_FAILURE`
* No token streaming; user progress remains AgentEvent/SSE

## Current Decisions

* Document-first threads; sync start + async execution (no job workers).
* Provider SDKs live in `apps/api` adapters — never in agent-core.
* OpenRouter uses Chat Completions (compat); OpenAI uses Responses API.
* Durable recovery = AgentRun/AgentStep rows (+ `latestRun` on messages).

## Verification Status

| Check | Status |
|---|---|
| `@opensuite/agent-core` unit tests | **Pass** |
| `contracts` / `db` / `engine-client` typecheck | **Pass** |
| `api` typecheck + unit + DB integration tests | **Pass** |
| `apps/web` typecheck + tests + `next build` | **Pass** |

## Intentionally Deferred

* Office tools / Rust engine / token streaming / model routing
* Durable event log, Redis/BullMQ/workers, confirmation resume API

## Recommended Next Step

Configure a provider in `.env` and smoke the document Agent panel, then add a real document inspect tool.
