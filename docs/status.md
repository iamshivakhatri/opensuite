# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **Phase F2.1:** Trash workspace permanent delete UX.
  - Trashed workspaces: Restore + Delete forever → `DELETE /api/trash/workspaces/:id`.
  - ConfirmDialog with larger-scope product copy (workspace + docs + versions + conversation + stored data; storage reclaimed; irreversible); visually distinct from document purge.
  - Success: drop workspace (+ its trash docs) from list, toast, `opensuite:storage-changed`; failure keeps row + toast, retryable.
  - Permanent delete remains Trash-only.

* **Phase E3:** Permanent workspace purge (backend).
* **Phase F2:** Settings → Storage + Trash document permanent delete.
* **Phase F1:** Settings → AI & Models UI.
* **Phase E2 / E1 / D1 / C1 / BYOK B2.1–A2:** storage accounting, trial, catalog/cost/ledger/prefs/credentials.

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
| `pnpm --filter @opensuite/web test` | **Pass** (73; F2.1 workspace purge helpers/API) |
| `git diff --check` | **Pass** |
| Browser screenshots (F1/F2/F2.1) | **Blocked** — headless Chrome SIGABRT / gstack browse daemon fails in agent env |
| API `documents.integration` (incl. workspace purge) | **Skipped** — `DATABASE_URL` host unreachable from agent |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish
* Usage / billing UI; Stripe; paid storage plans
* Version pruning / automatic cleanup
* First-party OpenAI/Anthropic model catalogs
* Hosted-alpha E2E visual acceptance (needs local GUI browser + reachable DB)

## Recommended Next Step

Manual browser pass on F1/F2/F2.1 (light/dark/narrow) on a machine with working Chrome, or Usage settings (trial + model usage ledger summary).
