# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C** (frozen unless evidence-backed).
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.

## Just Completed

* **BYOK Phase B2:** immutable estimated cost snapshot on `model_usage_event`
  (`estimated_cost_micros` / `cost_currency` / `pricing_version`).
  Exact-model pricing registry + pure calculator; Anthropic separate vs OpenAI-inclusive
  cached billing; reasoning never double-charged. Production registry empty (no invented
  prices). Unknown pricing → null cost, raw usage still recorded. Cost aggregation over
  stored snapshots only.
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
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.
* **Frontend visual pass complete** — stop broad UI polish; next is product/document capability integration.

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/db typecheck` | **Pass** |
| `pnpm --filter @opensuite/db test` | **Pass** |
| `pnpm --filter @opensuite/api typecheck` | **Pass** |
| `pnpm --filter @opensuite/api test` | **Pass** (147; 20 skipped DB/integration) |
| `pnpm --filter @opensuite/agent-core test` | **Pass** (194) |
| `git diff --check` | **Pass** |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Frontend Phase 3 panel file split
* Further generic UI polish
* Settings UI; managed trial credits, Stripe, invoices, usage UI
* Verified production price entries for managed defaults (`claude-sonnet-4-5`, `gpt-4.1`, OpenRouter slugs)
* Concurrency-safe trial debit (Phase D)

## Recommended Next Step

Add verified exact-model production pricing entries (or Settings UI for AI prefs), then Phase D managed trial debit over stored `managed` cost snapshots with concurrency protection.
