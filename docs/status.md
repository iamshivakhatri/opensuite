# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V2, Phase 2A** — Phase-1 tool loop + server-bound DOCX read tools (`document.capabilities` / `inspect` / `find`) via `bindDocxDocument` → N-API. Mutations not exposed yet.
* Existing Agent panel and hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.
* **Deploy scaffolding** — Atlas API-only compose; soft-boot without native engine; `@opensuite/engine` via npm (local `pnpm.overrides` → sibling link). See `docs/deploy.md`.

## Just Completed

* Phase 2A: deleted V1 DocumentRuntime bridge (`OpenSuiteEngineAdapter`, mutation/runtime/artifact-loader). Added `bindDocxDocument` + `createDocumentTools`; API binds exact primary version before `runAgent`.
* Real engine tests for caps/inspect/find; V2 tool binding + multi-tool-turn tests.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` builds API workspace deps first (`api^...`).
* Managed AI gateway = OpenRouter; Agent Core V2 owns the model/tool loop; API owns app shell + document binding.
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
| engine-client tests (incl. real N-API bind) | Pass |
| agent-core-v2 tests | Pass (10) |
| API typecheck | Pass |
| git diff --check | Pass |
| Manual Agent panel dogfood | pending (user) |

## Intentionally Deferred

* Phase 2B document mutations (replace/insert/format/tables/…)
* Parallel sibling tool execution
* Engine keepNext/keepLines/lineSpacing/indent fields
* First npm publish of `@opensuite/engine` (needs `NPM_TOKEN` + `@opensuite` scope)

## Recommended Next Step

Manually dogfood Agent panel with a DOCX open (capabilities/inspect/find), then Phase 2B mutations.
