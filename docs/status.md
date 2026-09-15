# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V2, Phase 2B** — Phase-1 tool loop + server-bound DOCX read/write tools via `bindDocxDocument` → N-API. Capability-gated typed mutations; immutable version persist mid-run; turn/tool backend logs.
* Existing Agent panel and hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.
* **Deploy scaffolding** — Atlas API-only compose; soft-boot without native engine; `@opensuite/engine` via npm (local `pnpm.overrides` → sibling link). See `docs/deploy.md`.

## Just Completed

* **P0 agent-run isolation** — run failures (maxTurns, provider/tool throws) convert to terminal product state (`failed`/`cancelled` + SSE) and must not kill the API process. Root cause: unobserved `Promise.finally` re-rejection in `run-manager` + rethrow after failure conversion in `execution`.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` builds API workspace deps first (`api^...`).
* Managed AI gateway = OpenRouter; Agent Core V2 owns the model/tool loop; API owns app shell + document binding + persistence + background-run containment.
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
| agent isolation tests (execution + run-manager) | Pass (5) |
| API typecheck | Pass |
| git diff --check | Pass |
| Manual Agent panel dogfood (maxTurns / failed run) | pending (user) |

## Intentionally Deferred

* Semantic document map / get_context / compaction / recovery / Progress Ledger
* Parallel sibling tool execution
* Engine keepNext/keepLines/lineSpacing/indent fields
* Frontend exposure of model-turn logs
* First npm publish of `@opensuite/engine` (needs `NPM_TOKEN` + `@opensuite` scope)
* Mutation schema / document tool correctness / repeated-failure / context cleanup (separate milestones)

## Recommended Next Step

Manually reproduce a maxTurns/failed agent run and confirm API stays up, run status=`failed`, and UI leaves "Finishing up...".
