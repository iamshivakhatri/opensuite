# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.6** + **AgentCore v2 Steps 1–5C**.
* **Agent Progress Control** — Progress Ledger + Stagnation Guard + One-Failure Recovery + Recovery Preflight v1.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.

## Just Completed

* **Live reliability dogfood** (OpenRouter `deepseek/deepseek-v4-flash-0731`, `AGENT_DEBUG_LIFECYCLE=1`) — 6 Word scenarios via real API. Recovery deferral + REDUNDANT_READ observed in prod path; no maxTurns inspect loops; provider timeouts stayed separate from document recovery. Preflight rarely hit (failures mostly formatting tools, excluded in v1). Artifacts: `/tmp/opensuite-dogfood-reliability/`.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).
* Managed model is server-chosen (`OPENROUTER_MODEL`); users do not pick it.
* Agent runs: valid BYOK preference wins; otherwise OpenSuite managed trial.
* `/health` stays HTTP 200 while the API process is up; clients read `database` / `status` for outages (not process kill).

## Verification Status

| Check | Status |
|---|---|
| agent-core tests/typecheck | **Pass** (252; +progress-preflight) |
| api mutation preflight test | **Pass** |
| live dogfood (6 scenarios) | **Done** — see handoff report in chat |
| `git diff --check` | **Pass** prior |

## Intentionally Deferred

* Recovery Preflight for formatting-session mutations / PPTX/XLSX
* Authoring Guidance v2 (structure/list/table quality)
* Engine keepNext/keepLines/lineSpacing/indent fields

## Recommended Next Step

Address top dogfood generals: (1) bulk-edit version churn, (2) table formatting tool-contract friction, (3) Authoring Guidance v2 — not more recovery machinery yet.
