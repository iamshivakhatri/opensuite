# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **Phase F2:** Settings → Storage + Trash document permanent delete.
  - Settings sections: Account / AI & Models / Storage / Appearance (`#storage`).
  - `GET /api/storage` usage bar (used / quota / remaining); near ≥90% and full states; Review Trash → `/app/trash`.
  - Trash documents: Restore + Delete forever → `DELETE /api/trash/documents/:id` with ConfirmDialog; notifies storage refresh.
  - Workspace permanent purge still deferred (Restore only).
  - Helpers: `storage-api.ts`, `storage-model.ts` (+ tests).

* **Phase F1:** Settings → AI & Models UI (managed/BYOK, catalog picker, trial, credentials).
* **Phase E2 / E1:** permanent document purge + storage accounting.
* **Phase D1 / C1 / BYOK B2.1–A2:** trial, concurrency, catalog/cost/ledger/prefs/credentials.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).
* Tool success authoritative; event-sink failures → `EVENT_SINK_FAILURE` separately.
* Usage persistence failures are logged and must not fail a successful model call.
* Cost is an insert-time snapshot; never reprice historical rows; unknown ≠ zero.
* Managed AI gateway = OpenRouter; catalog/pricing display from Models API; authoritative cost from `usage.cost`.
* Direct BYOK (OpenAI/Anthropic) records tokens; cost may stay null.
* Soft-deleted documents still consume storage until permanently purged.
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.
* **Frontend visual pass complete** — stop broad UI polish; next is product/document capability integration.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/web typecheck` | **Pass** |
| `pnpm --filter @opensuite/web test` | **Pass** (63; F1 + F2 storage/purge helpers) |
| `git diff --check` | **Pass** |
| Browser screenshots (F1/F2) | **Blocked** in agent sandbox (no GUI / headless Chrome SIGABRT) |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish
* Workspace permanent purge
* Usage / billing UI; Stripe; paid storage plans
* Version pruning / automatic cleanup
* First-party OpenAI/Anthropic model catalogs

## Recommended Next Step

Usage settings (trial + model usage ledger summary), or workspace permanent purge once retention rules are product-approved.
