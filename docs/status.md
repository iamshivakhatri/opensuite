# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Steps 1–5C complete:** document state, tool selection,
  terminalization, timeout recovery, context transformation, and model-turn
  mechanics have explicit generic boundaries.

## Just Completed

* AgentCore v2 Step 5C — extracted generic `executeModelTurn`.
  * Owns transformed model request preparation, answer-only suppression,
    timeout signal lifecycle/classification, streaming, metrics, required
    message events, one-retry policy decision, cancellation, and normalized
    completion/failure.
  * `AgentRunner` retains transcript mutation and the complete model/tool loop.
  * Successful ordering remains `message.started` → `message.delta*` →
    `model.turn.metrics` → `message.completed`.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).
* Tool success is authoritative once `execute()` resolves; later event/telemetry
  delivery failures fail the run separately (`EVENT_SINK_FAILURE`) instead of
  rewriting the tool outcome — never encourages an automatic retry of a
  completed side effect.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (191) |
| `pnpm --filter @opensuite/api test` | **Pass** (100 + 17 skip) |
| `pnpm typecheck` | **Pass** |
| `pnpm agent:bench` | **Pass** (5/5) |
| `git diff --check` | **Pass** |

## Benchmark (post Step 5C)

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731` — all 5 `ok`.
Turns: 2/4/3/4/4; tools: 1/3/5/6/5; failures: 0/0/0/0/0.

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics

## Recommended Next Step

**FREEZE AgentCore v2.** Continue only for product work or evidence-backed fixes,
not further structural decomposition.
