# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Steps 1–3:** see Just Completed.

## Just Completed

* AgentCore v2 Step 3 — externalized document run state from `AgentRunner`.
  * OpenSuite owns `DocumentRunState` (`primary` + `ArtifactHandleRegistry`) in `document-tools/run-state.ts`.
  * Injected `CreateToolExecutionContext` (fresh per tool call) so sequential writes still see N→N+1→N+2.
  * `TurnToolSelectorContext` no longer has `primaryDocument`; document selector closes over run state.
  * Removed `documentToolCatalog` / `runtime` / `mutations` from `AgentRunnerOptions`; use `createDocumentAgentRunnerOptions`.
  * `AgentRunner` LOC 1221 → 1170. Write-batch terminalization + authoring-timeout retry still in Runner (Step 4).

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (169) |
| `pnpm --filter @opensuite/api test` | **Pass** (100+17 skip) |
| `pnpm typecheck` | **Pass** |
| `pnpm agent:bench` | **Pass** (5/5) |
| `git diff --check` | **Pass** |

## Benchmark (post Step 3)

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731` — all 5 `ok`. Turns: 2/3/4/5/3 (Step 2 baseline was 2/4/3/4/3; live-model variance, correctness invariants hold).

## Intentionally Deferred

* AgentCore v2 Step 4 only: extract write-batch terminalization + authoring-timeout-retry (still hardcode create/`document.*` in `runner.ts`)
* Planner/DAG/sub-agents; model bakeoff; production analytics

## Recommended Next Step

AgentCore v2 Step 4: extract write-batch terminalization and authoring-timeout retry out of `AgentRunner`.
