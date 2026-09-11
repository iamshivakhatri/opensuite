# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **BYOK Phase B1:** append-only `model_usage_event` ledger at the `AgentModel.complete` boundary.
  Trusted user/provider/model/`byok|managed` attribution; provider-reported tokens (nullable when absent).
  Streaming Anthropic/OpenRouter usage gaps fixed; no credits/billing yet.
* BYOK Phase A3: per-user provider/model/source preference and server-side
  agent model resolution; managed fallback remains for users without a choice.
* BYOK Phase A2: authenticated provider-credential lifecycle APIs
  (`GET/PUT /api/provider-credentials`, `DELETE /api/provider-credentials/:provider`)
  over the A1 domain service; safe metadata only.
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
* Usage persistence failures are logged and must not fail a successful model call.
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.
* **Frontend visual pass complete** — stop broad UI polish; next is product/document capability integration.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/db typecheck` | **Pass** |
| `pnpm --filter @opensuite/api typecheck` | **Pass** |
| `pnpm --filter @opensuite/api test` | **Pass** (135; 20 skipped DB/integration) |
| `pnpm --filter @opensuite/agent-core test` | **Pass** (194) |
| `git diff --check` | **Pass** |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish
* Settings UI; managed trial credits, billing, quotas, usage UI
* Normalized dollar-cost / pricing catalog

## Recommended Next Step

Add a Settings UI for AI preference and credential lifecycle APIs, or Phase B2 managed trial cost accounting on top of the usage ledger.
