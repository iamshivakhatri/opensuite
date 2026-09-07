# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1/v2:** projection, timeouts, force-tools, write-batch terminalization, historical arg compaction, create-force stops after mutation **or** inspect/find on open primary.
* **Agent Efficiency v3 (bench):** `pnpm agent:bench` — canonical scenarios A–E, reuses `model.turn.metrics` / `tool.execution.metrics`, JSON under `.agent-bench/` (gitignored). Fake-model architecture invariants in agent-core tests.

## Just Completed

* Reproducible agent benchmark harness (no AgentRunner redesign). Live suite vs production OpenRouter `deepseek/deepseek-v4-flash-0731`.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT for caps/mutations; `pnpm dev:api` rebuilds agent-core first.
* Terminalize only when confirmation text is ≥12 chars, all tools succeeded, ≥1 document write.
* Canonical transcript keeps full tool args; model-facing context may compact large executed writes.
* Bench is developer-only — not production analytics.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (160) |
| `pnpm --filter @opensuite/api test` | **Pass** (100+17 skip) |
| `pnpm agent:bench` (prod model) | **Pass** (5/5 correctness) |
| `git diff --check` | **Pass** |

## Benchmark (production model, 2026-09-07)

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731`

| Scenario | OK | Turns | Tools | Total | Model | Tool/engine | Failures |
|---|---|---|---|---|---|---|---|
| simple-read | ok | 2 | 1 | 4.4s | 4.4s | ~0 | 0 |
| simple-edit | ok | 4 | 4 | 27.8s | 27.7s | ~0 | 1 (style→text fallback) |
| greenfield-small | ok | 4 | 5 | 6.9s | 6.9s | ~0 | 0 |
| greenfield-large | ok | 4 | 6 | 28.3s | 28.3s | ~0 | 0 |
| reason-mutate | ok | 6 | 8 | 19.2s | 19.2s | ~0 | 1 (retry cell write) |

* Suite: model **86.6s** vs tool/engine **0.1s** vs persist **~0**.
* greenfield-large heaviest turn (batched authoring): wall **20.2s**, TTFT **11.3s**, post-ttft **8.8s**, tool-arg bytes **1255** (not huge JSON).
* Existing-doc tool schema ~**23KB**/turn; post-inspect context up to ~**20KB**.
* Token usage often absent from OpenRouter stream for this model (reported as —).

**Largest remaining bottleneck:** model/provider latency (especially TTFT on large authoring turns) — **not** AgentCore loop, engine, or persistence.

## Intentionally Deferred

* Planner/DAG/sub-agents; lists/images; table themes; AgentRunner redesign; production analytics

## Recommended Next Step

Reduce model-facing tool-schema / inspect-result bytes (23KB schema + large inspect payloads) and/or try a lower-TTFT model — **do not** rewrite AgentRunner without a schema/context experiment first.
