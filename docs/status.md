# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.6** + **AgentCore v2 Steps 1–5C**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.

## Just Completed

* **Protocol hardening v7.3:** one bullet-list request can safely target separate direct-body runs in source order; decimal lists remain consecutive-only.

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
| api `app.test.ts` | **Pass** (16; includes health degraded + DATABASE_UNAVAILABLE) |
| db errors + package tests | **Pass** (17; 1 skipped live connect) |
| web typecheck | **Pass** |
| web tests | **Pass** (85) prior |
| agent-core tests/typecheck | **Pass** (219) |
| api tests (full) | **Pass** (183; 23 skipped) |
| Provider benchmark | **Partially complete** |
| Visual `/dev/agent-panel-ux` | **Reviewed** prior |
| Live signed-in agent run | **Blocked** (auth 403) prior |

## Intentionally Deferred

* Engine keepNext/keepLines/lineSpacing/indent fields
* Live in-app agent screenshot pass (needs signed-in session)

## Recommended Next Step

Restore Tailscale/Postgres reachability and confirm banner clears within ~5s; smoke a signed-in `/app` reload during a brief DB blip.
