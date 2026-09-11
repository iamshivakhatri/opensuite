# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **BYOK Phase B2.1:** dynamic managed model catalog + OpenRouter provider-reported cost.
  - `GET /api/ai-models/managed` — OpenRouter Models API (`text` + `tools`), 10m in-process TTL, stale-on-error.
  - Managed prefs: `provider=openrouter` + exact OpenRouter model id; validated against catalog.
  - OpenRouter `usage.cost` → integer `cost_micros` (half-up); source `openrouter_usage_cost`.
  - Schema rename (pre-production): `estimated_cost_micros`→`cost_micros`, `pricing_version`→`cost_source`.
  - B2 static registry remains empty/test-only; not used for managed OpenRouter billing.
* **BYOK Phase B2:** immutable cost snapshot on `model_usage_event`.
* **BYOK Phase B1:** append-only `model_usage_event` ledger at `AgentModel.complete`.
* BYOK Phase A3: per-user provider/model/source preference + managed fallback.
* BYOK Phase A2: provider-credential lifecycle APIs (safe metadata only).
* DOCX agent surface covers the current 35-capability Node manifest.
* Trash removes the file from open tabs; shell token lock; explorer rhythm tokens.

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
| `pnpm --filter @opensuite/db typecheck` | **Pass** |
| `pnpm --filter @opensuite/db test` | **Pass** |
| `pnpm --filter @opensuite/api typecheck` | **Pass** |
| `pnpm --filter @opensuite/api test` | **Pass** (165; 20 skipped DB/integration) |
| `pnpm --filter @opensuite/agent-core test` | **Pass** (194) |
| `git diff --check` | **Pass** |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish
* Settings UI / model picker
* Managed trial credits, Stripe, invoices, usage UI
* Concurrency-safe trial debit (Phase D)
* Static production price entries (not needed for managed OpenRouter)

## Recommended Next Step

Phase D managed trial debit over stored `managed` + `openrouter_usage_cost` snapshots (with one-active-run concurrency), or Settings UI wired to `GET /api/ai-models/managed`.
