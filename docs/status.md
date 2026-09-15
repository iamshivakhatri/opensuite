# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.6** + **AgentCore v2 Steps 1–5C**.
* **Agent Core V2 runtime, Phase 0A** — separate one-shot OpenRouter stream behind `AGENT_RUNTIME=v2`; V1 remains default; live acceptance pending a V2-started API process.
* **Agent Progress Control** — Progress Ledger + Stagnation Guard + One-Failure Recovery + Recovery Preflight v1.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.
* **Deploy scaffolding** — Atlas API-only compose; soft-boot without native engine; `@opensuite/engine` via npm (local `pnpm.overrides` → sibling link). See `docs/deploy.md`.

## Just Completed

* Agent execution lease: clear orphans on API boot + release on SSE `RUN_ABANDONED`; true-busy 409 includes `activeThreadId` so UI can switch to that chat.
* Soft-boot API without engine; Docker stub by default; local still uses sibling `link:` for `@opensuite/engine` (~2.6MB .node — fine for GitHub later). npm publish deferred.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).
* Managed model is server-chosen (`OPENROUTER_MODEL`); users do not pick it.
* Agent runs: valid BYOK preference wins; otherwise OpenSuite managed trial.
* `/health` stays HTTP 200 while the API process is up; clients read `database` / `status` for outages (not process kill).
* Hosted signup closed by default (`ALLOW_SIGNUP=false` in compose); open locally (default `true`).
* Local engine: root `pnpm.overrides` links sibling `opensuite-engine`; Docker defaults to stub until npm publish.

## Verification Status

| Check | Status |
|---|---|
| api soft-boot / config | soft-boot wired; config tests prior **Pass** (21) |
| Docker image build | not run here |
| Local engine require (darwin) | **Pass** after loader change |

## Intentionally Deferred

* Recovery Preflight for formatting-session mutations / PPTX/XLSX
* Authoring Guidance v2 (structure/list/table quality)
* Engine keepNext/keepLines/lineSpacing/indent fields
* First npm publish of `@opensuite/engine` (needs `NPM_TOKEN` + `@opensuite` scope)

## Recommended Next Step

Redeploy Atlas (soft-boot stops restart loop). Publish `@opensuite/engine` from opensuite-engine CI, then rebuild with `USE_PUBLISHED_ENGINE=true`.
