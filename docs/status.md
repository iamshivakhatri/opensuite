# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v4** + **AgentCore v2 Steps 1–5C**; poem efficiency benchmark records explicit read/write/inspect/failure counters.
* **Agent Efficiency v4.2a:** tool-turn finalization hook allows a future document session to finalize outcomes before completion events and transcript updates.
* **Agent Efficiency v4.2b1:** `executeWithBytes` runs verified DOCX mutations on caller-owned working bytes without persistence.
* **Agent Efficiency v4.2b2:** API formatting session accumulates three safe formatting mutations in working bytes and flushes one immutable version.
* **Agent Efficiency v4.2b3a:** executor can represent non-durable pending formatting results for later tool-turn finalization.
* **Agent Efficiency v4.2b3b1:** pending formatting results flow through tools; executor exposes explicit flush/abandon controls.
* **Agent Efficiency v4.2b3b2a:** lifecycle provides run/event context and a generic pre-tool hook for future document flush boundaries.
* Confirmation bridge — real Approve/Deny over HTTP (in-memory pending map).
* Frontend Phases 1–3 + **4A–4C** + **5A–5B** + **6A–6B** + readability + **shell/format unification**.
* Hosted-alpha foundation: auth, workspaces/docs/versions, DOCX 35/35, BYOK, managed OpenRouter, catalog/cost/ledger, trial, storage quota, purge, Settings AI/Storage, Trash.

## Just Completed

* Removed sidebar **Apps** section (Write / Slides / Sheets) and format-library pages; workspaces remain the home for all file types.
* **Hosted-alpha E2E validation** (QA / integration-hardening).
  - Applied pending DB migrations (`0011`/`0012` family) — tables were missing (`agent_execution_lease`, storage/trial/usage/credentials).
  - Full automated suites green with `RUN_DB_INTEGRATION_TESTS=true` (API **191/191**, 0 skipped).
  - Deterministic harness: account, concurrency busy, storage quota concurrency, trial debit/idempotency, document+workspace purge, failure shapes.
  - Fixed stale agent-execution assertion (model turn includes working-set prefix; persisted message stays raw).

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; authoritative cost from `usage.cost`.
* Soft-deleted documents still consume storage until permanently purged.
* **AgentCore v2 frozen** — product/frontend work only unless evidence-backed fixes.
* Live private alpha needs: `AI_CREDENTIAL_ENCRYPTION_KEY`, `MANAGED_AI_TRIAL_CREDIT_MICROS>0`, migrations applied.

## Verification Status

| Check | Status |
|---|---|
| DB typecheck/tests | **Pass** (17) |
| API typecheck + tests (`RUN_DB_INTEGRATION_TESTS=true`) | **Pass** (191; 0 skipped) |
| Web typecheck/tests | **Pass** (73; Apps section removed) |
| agent-core / engine-client / contracts typecheck+tests | **Pass** |
| `git diff --check` | **Pass** |
| Lease / purge / trial / quota-concurrency harness | **Pass** |
| Live BYOK / managed trial on this `.env` | **Blocked** — enc key missing; trial micros=0 |
| Browser visual (F1/F2/F2.1) | **Blocked** — Playwright Chromium missing in agent env |

## Intentionally Deferred

* Planner/DAG/sub-agents; model bakeoff; production analytics
* Confirmation bridge durable resume / Redis workers
* Usage / billing UI; Stripe; paid storage plans
* Version pruning; first-party OpenAI/Anthropic catalogs
* Manual GUI visual pass (light/dark/narrow) once Playwright/Chrome browse works

## Recommended Next Step

Set `AI_CREDENTIAL_ENCRYPTION_KEY` + `MANAGED_AI_TRIAL_CREDIT_MICROS` in `.env`, restart API, then manual browser pass on Settings AI/Storage + Trash (light/dark/narrow).
