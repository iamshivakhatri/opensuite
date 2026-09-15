# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V2, Phase 0B** — the only agent runtime: one OpenRouter stream, persisted messages/runs, and small SSE events. Tool execution and document mutations are not part of V2 yet.
* Existing Agent panel and hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.
* **Deploy scaffolding** — Atlas API-only compose; soft-boot without native engine; `@opensuite/engine` via npm (local `pnpm.overrides` → sibling link). See `docs/deploy.md`.

## Just Completed

* Phase 0B: removed the old agent runtime and runtime switching. The API now validates and persists application data, then calls `agent-core-v2` once per run.
* V1 fallout cleanup: deleted dead `@opensuite/agent-core` tests; Phase-2 adapter/loader sources kept on disk but excluded from `tsc` until DocumentRuntime types return.
* Engine document adapters remain in place for Phase 2; they are not wired into the current V2 runtime.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` builds API workspace deps first (`api^...`).
* Managed AI gateway = OpenRouter; Agent Core V2 is intentionally one streamed model call for Phase 0.
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
| V2 runtime / API shell | engine-client + agent-core-v2 build; API typecheck |
| Docker image build | not run here |
| Local engine require (darwin) | **Pass** after loader change |

## Intentionally Deferred

* Phase 1 agent tools and document operations
* Engine keepNext/keepLines/lineSpacing/indent fields
* First npm publish of `@opensuite/engine` (needs `NPM_TOKEN` + `@opensuite` scope)

## Recommended Next Step

Manually test the Agent panel with a V2-started API process, then begin Phase 1 only after that path is accepted.
