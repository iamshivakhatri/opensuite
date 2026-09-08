# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Steps 1–5B:** document state, tool selection, terminalization, timeout recovery,
  event-sink correctness, and context transformation are outside the generic runner.

## Just Completed

* AgentCore v2 Step 5B — dependency-invert context transformation.
  * `AgentRunnerOptions.transformContext?: TransformAgentContext` — called
    immediately before each `model.complete`; default is identity
    (`identityTransformContext`).
  * `runner.ts` no longer imports `model-context.ts` / OpenSuite projection.
  * OpenSuite injects the existing `transformContext` via
    `createDocumentAgentRunnerPolicyOptions` (also used by
    `createDocumentAgentRunnerOptions`, API execution, bench harness).
  * Canonical runtime transcript unchanged; projection is model-facing only.

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
| `pnpm --filter @opensuite/agent-core test` | **Pass** (181) |
| `pnpm --filter @opensuite/api test` | **Pass** (100+17 skip) |
| `pnpm typecheck` | **Pass** |
| `pnpm agent:bench` | **Pass** (5/5) |
| `git diff --check` | **Pass** |

## Benchmark (post Step 5B)

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731` — all 5 `ok`.
Turns: 2/4/4/3/4; tools: 1/3/5/6/6; failures: 0/0/0/1/0 (one create_table retry in
greenfield-large — live-model variance). Behavior unchanged aside from normal
turn-count variance.

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics

## Recommended Next Step

Extract model-turn execution from `AgentRunner` as the next AgentCore v2 milestone.
