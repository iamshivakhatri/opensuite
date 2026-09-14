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
* **Deploy scaffolding** — `Dockerfile` + `docker-compose.yml` (API/Postgres/MinIO for Dokploy); `apps/web/vercel.json`; signup gate via `ALLOW_SIGNUP` / `NEXT_PUBLIC_ALLOW_SIGNUP`; `AUTH_CROSS_ORIGIN` for Vercel↔API cookies. See `docs/deploy.md`.

## Just Completed

* Hosted deploy files + signup/cross-origin auth env flags.
* Table/style tool contract cleanup: nested shading targets and truthful Rust diagnostics for table lookup and stylesheet/style failures.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).
* Managed model is server-chosen (`OPENROUTER_MODEL`); users do not pick it.
* Agent runs: valid BYOK preference wins; otherwise OpenSuite managed trial.
* `/health` stays HTTP 200 while the API process is up; clients read `database` / `status` for outages (not process kill).
* Hosted signup closed by default (`ALLOW_SIGNUP=false` in compose); open locally (default `true`).

## Verification Status

| Check | Status |
|---|---|
| api config tests (ALLOW_SIGNUP / AUTH_CROSS_ORIGIN) | **Pass** (20) |
| Docker image build | not run here (needs ENGINE_GIT_URL + network) |
| agent-core tests/typecheck | **Pass** (252) |
| engine-client tests | **Pass** (69) |
| Rust DOCX tests + cargo fmt --check | **Pass** (118) |

## Intentionally Deferred

* Recovery Preflight for formatting-session mutations / PPTX/XLSX
* Authoring Guidance v2 (structure/list/table quality)
* Engine keepNext/keepLines/lineSpacing/indent fields
* Publishing `@opensuite/engine` linux binaries (compose builds from `ENGINE_GIT_URL`)

## Recommended Next Step

Wire Dokploy + Vercel with real HTTPS URLs, build API with `ENGINE_GIT_URL`, create first user with temporary `ALLOW_SIGNUP=true`, then lock signup.
