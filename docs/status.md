# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* BYOK credential foundation: per-user/provider encrypted credential table and
  AES-256-GCM server-side domain service; no routes or runtime wiring yet.
* DOCX agent surface covers the current 35-capability Node manifest, including table
  column widths and cell shading; all writes use the immutable-version executor.
* Trash removes the file from open tabs (no re-upsert race).
* Shell token lock: Casual Docs `:root` no longer overrides OpenSuite `--text-*` /
  `--radius-*` / `--color-*` on DOCX open (see `apps/web/src/app/globals.css`).
* Explorer rhythm: `--explorer-row-h` / `--explorer-list-gap` (30px / 3px); softer type.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).
* Tool success authoritative; event-sink failures → `EVENT_SINK_FAILURE` separately.
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.
* **Frontend visual pass complete** — stop broad UI polish; next is product/document capability integration.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/web typecheck` | **Pass** |
| `pnpm --filter @opensuite/web test` | **Pass** (33) |
| `git diff --check` | **Pass** |
| Live auth screenshots | User-provided |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish

## Recommended Next Step

Add authenticated credential lifecycle routes that use the BYOK domain service;
keep provider resolution and settings UI separate milestones.
