# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Steps 1–5C complete:** document state, tool selection,
  terminalization, timeout recovery, context transformation, and model-turn
  mechanics have explicit generic boundaries.
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A** (tabs/chrome).

## Just Completed

* Frontend Phase 4A — document tabs + document chrome.
  * Tab strip: clearer active/inactive states, denser sizing, truncation,
    close affordance, `⋯` overflow menu (active tab always kept visible).
  * Dirty dot only when `editorStatus.dirty` is true for the mounted document
    (no invented per-tab dirty state).
  * Header: document title primary; workspace + format secondary; Save /
    Download grouped; star/trash as icon actions.
  * Pure overflow partition in `lib/tab-overflow.ts` (+ unit tests).

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).
* Tool success is authoritative once `execute()` resolves; later event/telemetry
  delivery failures fail the run separately (`EVENT_SINK_FAILURE`) instead of
  rewriting the tool outcome — never encourages an automatic retry of a
  completed side effect.
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/web typecheck` | **Pass** |
| `pnpm --filter @opensuite/web test` | **Pass** (22) |
| `git diff --check` | **Pass** |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* **Frontend Phase 4B** — editor remount / version-refresh polish
* Frontend Phase 5 — a11y sweep

## Recommended Next Step

Frontend Phase 4B — reduce remount-flash on agent version refresh (preserve
scroll/cursor or load into live instance) while keeping conflict/dirty-suppression
guarantees.
