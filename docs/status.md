# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v3:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, create-force Q&A fix, `pnpm agent:bench`.
* **Agent Efficiency v4:** leaner tool descriptions/schemas + system prompt; slimmer model-facing inspect/mutation projection; fixture styles for Heading 1; semantic-cell guidance for batched writes.

## Just Completed

* v4 lean model surface + failure root-causes (style fixture; stale handles on batched cell writes). Re-benched vs `deepseek/deepseek-v4-flash-0731`.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (163) |
| `pnpm --filter @opensuite/api test` | **Pass** (100+17 skip) |
| `pnpm agent:bench` | **Pass** (5/5) |
| `git diff --check` | **Pass** |

## Benchmark (same model) BEFORE v3 → AFTER v4

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731`

| Scenario | Turns B→A | Fail B→A | Total B→A | Schema B→A |
|---|---|---|---|---|
| simple-read | 2→2 | 0→0 | 4.4s→4.4s | 23.0→16.6KB |
| simple-edit | 4→4 | 1→0 | 27.8s→5.8s | 23.0→16.6KB |
| greenfield-small | 4→3 | 0→1* | 6.9s→20.3s | 7.4→5.4KB post-create |
| greenfield-large | 4→5 | 0→0 | 28.3s→18.7s | (same pattern) |
| reason-mutate | 6→4 | 1→0 | 19.2s→13.5s | 23.0→16.6KB |

\*one `create_table` invalid input then retry — model-side, not engine contract.

* Catalog ~**22592→16301** bytes; system prompt ~**4055→2410** bytes.
* Suite model time ~**86.6s→62.7s**; engine/persist still ~0.
* simple-edit style now succeeds (fixtures include styles.xml).
* reason-mutate: no cell-write retry (semantic targeting / guidance).
* Greenfield still not reliably 2 turns (model splits authoring) — guidance tightened; not AgentRunner rewrite.

**Largest remaining bottleneck:** model/provider latency + model turn-splitting on greenfield — not engine/persistence.

## Intentionally Deferred

* Planner/DAG/sub-agents; AgentRunner redesign; model bakeoff; production analytics

## Recommended Next Step

Optional: further slim large `inspect(tables)` affordance payloads, or nudge post-create narrow catalog to keep style+table+Done in one forced-tools turn — still without rewriting AgentRunner.
