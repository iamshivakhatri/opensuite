# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4:** projection, timeouts, force-tools, write-batch terminalization, arg compaction, lean model surface.
* **AgentCore v2 Steps 1–5C complete:** document state, tool selection,
  terminalization, timeout recovery, context transformation, and model-turn
  mechanics have explicit generic boundaries.

## Just Completed

* Frontend Phase 2 — dialog/menu deduplication on shared UI primitives.
  * `sidebar.tsx` / `workspaces-home.tsx` / `command-palette.tsx` use
    `components/ui/dialog.tsx` (local Modal/Dialog shells removed).
  * Sidebar + workspaces-home workspace actions use shared `ContextMenu`.
  * Behavior preserved: Escape, overlay dismiss, rename/delete/upload/create
    callbacks; palette pickers stay above palette via `--z-popover`.

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
| `pnpm --filter @opensuite/web test` | **Pass** (17) |
| `git diff --check` | **Pass** |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Frontend Phase 3 (agent panel confirm/retry/version notice)

## Recommended Next Step

Frontend Phase 3 — agent panel: wire confirmation UI, version-updated notice, and retry.
