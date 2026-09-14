# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.6** + **AgentCore v2 Steps 1–5C**.
* **Agent Progress Control** — Progress Ledger + Stagnation Guard + One-Failure Recovery Mode + **Recovery Preflight v1**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.

## Just Completed

* **Recovery Preflight v1** — while recovery active, eligible DOCX content mutations validate via `loadBytes` + `executeWithBytes` then promote exact verified bytes (no double execute). Invalid candidates return `RECOVERY_PREFLIGHT_REJECTED` (skipped, not `tool.failed`); formatting mutations excluded (separate session). Exact-repeat blocked; **3** distinct rejections → `RECOVERY_EXHAUSTED`. Persist failure after preflight success stays real infra failure.

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
| api typecheck + mutation preflight test | **Pass** |
| formatting / persist mutation tests | **Pass** |
| `git diff --check` | **Pass** |
| api `app.test.ts` | **Pass** prior |
| db / web | **Pass** prior |

## Intentionally Deferred

* Recovery Preflight for formatting-session mutations / PPTX/XLSX
* Engine keepNext/keepLines/lineSpacing/indent fields
* Live in-app agent screenshot pass (needs signed-in session)

## Recommended Next Step

Dogfood recovery+preflight on a multi-write TARGET_NOT_FOUND scenario with `AGENT_DEBUG_LIFECYCLE=1`.
