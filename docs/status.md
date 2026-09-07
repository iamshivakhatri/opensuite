# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1:** projection, 90s timeout, force-tools until create/first write, narrowed post-create catalog, authoring timeout retry.
* **Agent Efficiency v2:** write-batch terminalization; historical tool-arg compaction; create-force stops after mutation **or** after inspect/find on an already-open primary (Q&A must not fail with create-nudge).

## Just Completed

* Fixed open-doc Q&A failure (`ff305f73`): create-force/nudge stayed active after inspect, then failed with “required tools after a nudge”. After inspect/find on a started-with-primary run, toolChoice/nudge become auto so text answers complete.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT for caps/mutations; `pnpm dev:api` rebuilds agent-core first.
* Terminalize only when confirmation text is ≥12 chars, all tools succeeded, ≥1 document write (not create-alone / not read-only).
* Canonical transcript keeps full tool args; model-facing context may compact large executed writes.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (155) |
| `pnpm --filter @opensuite/api test` | **Pass** (98+17 skip) |
| Live smoke | Create+writes work; 2-turn terminalization model-dependent |

## Benchmark (e7989bc4 BEFORE → target)

| | BEFORE (`e7989bc4`) | Target |
|---|---|---|
| Model turns | 4 (create → author → author → final) | 2 |
| Turn latencies | 6.4s / 42s / 22s / 2.5s | — |
| Total | ~75s | provider-bound |
| Final turn | tools=0 confirmation | folded into authoring |

## Intentionally Deferred

* Planner/DAG/sub-agents; lists/images; table themes; AgentRunner redesign

## Recommended Next Step

Restart `pnpm dev:api`, then re-ask “What does the second paragraph say?” on the reading plan — should inspect once and answer.
