# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **Phase E2:** permanent purge for soft-deleted documents.
  - `DELETE /api/trash/documents/:documentId` removes only an owned trashed document, its version objects and rows, then atomically releases the exact persisted bytes.
  - The document row is locked through object deletion/finalization; retries after partial object or DB failure are safe, and storage accounting never goes negative.

* **Phase E1:** per-user immutable-version storage accounting and quota enforcement.
  - `USER_STORAGE_QUOTA_BYTES` defaults to 500 MiB; upload, blank DOCX, manual save, and agent version append reserve exact bytes atomically.
  - Soft delete retains usage. Migration backfills from existing version ownership; `GET /api/storage` returns used, quota, and remaining bytes.

* **Phase D1:** managed OpenRouter one-time trial credit.
  - `MANAGED_AI_TRIAL_CREDIT_MICROS` grants lazily once; zero disables managed trial.
  - Each managed model call is gated; durable provider-reported cost debits atomically through a unique usage-event record.
  - Missing cost or durable accounting failure blocks later managed calls; BYOK never touches trial credit.
  - A final allowed provider call may overshoot once; the next call is blocked.

* **Phase C1:** one active agent execution per authenticated user, across API instances.
  - PostgreSQL `agent_execution_lease` is atomically acquired before model resolution or run creation.
  - Lease is token-checked on release, renewed every minute while active, and expires after five minutes if an API process crashes.

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
* Stripe, invoices, usage UI
* Static production price entries (not needed for managed OpenRouter)

## Recommended Next Step

Settings UI wired to `GET /api/ai-models/managed`, `GET /api/ai-trial`, and `GET /api/storage`; workspace purge needs separate retention and agent-history rules.
