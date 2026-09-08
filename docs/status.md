# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Steps 1–4:** document state, tool selection, terminalization,
  and timeout recovery policy are outside the generic runner.
* **AgentCore v2 Step 5A:** tool-success vs event-sink-failure correctness
  boundary in `AgentRunner`.

## Just Completed

* AgentCore v2 Step 5A — fixed a correctness bug where a later event/telemetry
  emission failure could rewrite an already-successful tool execution as
  failed.
  * `executeOneToolCall` now separates `tool.execute()` (execution facts) from
    `tool.completed`/metrics emission (observation facts). Once `execute()`
    resolves, the returned `ToolOutcome` is authoritative and is never
    rewritten by a later emit failure.
  * `tool.completed` emit failure after success → captured as an
    `EVENT_SINK_FAILURE` diagnostic; the run ends `failed` (infra failure)
    with the successful `ToolOutcome` preserved — the model is never told
    the tool failed, so it cannot retry a mutation that already happened.
  * `tool.execution.metrics` / `model.turn.metrics` are now emitted through a
    new `emitTelemetry` helper that swallows sink failures — observability-only
    events can never invalidate a successful model turn or tool execution.
  * Real tool-execution failures (`tool.execute()` throws) are unchanged:
    `tool.failed` + failed `ToolOutcome` + structured diagnostic.
  * `AgentRunner` remains document-agnostic — no document/workspace-specific
    checks were added; the fix is generic to any side-effecting tool.

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
| `pnpm --filter @opensuite/agent-core test` | **Pass** (179) |
| `pnpm --filter @opensuite/api test` | **Pass** (100+17 skip) |
| `pnpm typecheck` | **Pass** |
| `pnpm agent:bench` | **Pass** (5/5) |
| `git diff --check` | **Pass** |

## Benchmark (post Step 5A)

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731` — all 5 `ok`.
Turns: 2/3/4/4/4; tools: 1/3/5/6/5; failures: 0/0/0/0/0. Unchanged behavior
(normal model-turn-count variance, no latency regression from this fix).

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics

## Recommended Next Step

Extract model-turn execution from `AgentRunner` (deferred by Step 5A) as the
next AgentCore v2 milestone.
