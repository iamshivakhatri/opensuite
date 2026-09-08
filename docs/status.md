# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Step 1:** removed dead `AgentRunContext`; `document.version.advanced` now emitted from `executePersistedMutation` (not AgentRunner).
* **AgentCore v2 Step 2:** `AgentRunner` delegates turn tool-surface/tool-choice to one injected `TurnToolSelector` hook (see `docs/agent_core.md`).

## Just Completed

* AgentCore v2 milestone 2 — extracted turn-tool selection. `AgentRunner` calls `selectTurnTools` once per turn instead of owning capability bootstrap/re-discovery, post-create narrowing, and create/write force-tools policy. That policy (moved verbatim) now lives in `createDocumentTurnToolSelector` (`document-tools/turn-tool-selector.ts`); `AgentRunnerOptions.documentToolCatalog` is a thin back-compat convenience that builds it. The "nudge to use tools" check is now generic (`toolChoice === "required"`) — no document tool names in that path. Behavior-preserving; all existing tests pass unchanged; bench 5/5.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).
* AgentCore v2 migration continues incrementally; next is `RunDocumentState`/handle ownership + terminalization extraction (not started).

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (165) |
| `pnpm --filter @opensuite/api test` | **Pass** (100+17 skip) |
| `pnpm typecheck` | **Pass** |
| `pnpm agent:bench` | **Pass** (5/5) |
| `git diff --check` | **Pass** |

## Benchmark (post Step 2)

Provider/model: `openrouter` / `deepseek/deepseek-v4-flash-0731` — all 5 scenarios `ok`, turn counts unchanged (2/4/3/4/3). Latency noise vs prior runs; invariants hold (success, turns in expected band, version events intact).

## Intentionally Deferred

* AgentCore v2 Steps 3+: `RunDocumentState`/`ArtifactHandleRegistry` ownership move, terminalization + authoring-timeout-retry extraction (still reference `CREATE_BLANK_TOOL`/`document.*` in `runner.ts`), context-hook injection
* Planner/DAG/sub-agents; model bakeoff; production analytics

## Recommended Next Step

AgentCore v2 Step 3: move `RunDocumentState` / `ArtifactHandleRegistry` ownership and write-batch terminalization (+ authoring-timeout-retry, which still hardcodes `workspace.create_blank_docx`/`document.*`) out of `AgentRunner`.
