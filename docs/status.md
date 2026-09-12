# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **Phase F1:** Settings → AI & Models UI.
  - Settings sections: Account / AI & Models / Appearance (`#ai`, `#appearance`).
  - Mode: OpenSuite managed vs bring-your-own-key; searchable managed model picker from `GET /api/ai-models/managed`.
  - BYOK provider rows (OpenAI / Anthropic / OpenRouter): connect / replace / remove; password dialog; keys never re-rendered.
  - Preference save via `PUT /api/ai-preferences`; trial strip from `GET /api/ai-trial`.
  - Helpers: `apps/web/src/lib/ai-settings-api.ts`, `ai-settings-model.ts` (+ tests).

* **Phase E2:** permanent purge for soft-deleted documents.
* **Phase E1:** per-user immutable-version storage accounting and quota.
* **Phase D1:** managed OpenRouter one-time trial credit.
* **Phase C1:** one active agent execution per authenticated user.
* **BYOK B2.1 / B2 / B1 / A3 / A2:** catalog, cost, ledger, preferences, credentials.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Terminalize on Done (≥12 chars) + successful writes; canonical transcript stays rich.
* Bench stays developer-local (`.agent-bench/`).
* Tool success authoritative; event-sink failures → `EVENT_SINK_FAILURE` separately.
* Usage persistence failures are logged and must not fail a successful model call.
* Cost is an insert-time snapshot; never reprice historical rows; unknown ≠ zero.
* Managed AI gateway = OpenRouter; catalog/pricing display from Models API; authoritative cost from `usage.cost`.
* Direct BYOK (OpenAI/Anthropic) records tokens; cost may stay null.
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.
* **Frontend visual pass complete** — stop broad UI polish; next is product/document capability integration.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/web typecheck` | **Pass** |
| `pnpm --filter @opensuite/web test` | **Pass** (51; includes AI settings model + API client) |
| `git diff --check` | **Pass** |
| Browser screenshots (F1) | **Blocked** in this agent environment (no GUI / headless Chrome SIGABRT under sandbox) |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish
* Usage / Storage settings UI
* Stripe, invoices
* Static production price entries (not needed for managed OpenRouter)
* First-party OpenAI/Anthropic model catalogs

## Recommended Next Step

Settings → Storage (wire `GET /api/storage` + trash/purge UX), or Usage once product copy for trial/ledger is ready.
