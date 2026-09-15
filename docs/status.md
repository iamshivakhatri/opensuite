# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V2, Phase 2B.2** — mutation contracts truthful: zero-based occurrence (matches find/inspect), closed tool schemas, `VALIDATION_FAILED` for bad shapes (not `DISPATCH_FAILED`), capability gated by schema + dispatcher. 28 model mutation tools; `insert_picture`/`replace_picture` hidden (binary).
* Existing Agent panel and hosted-alpha foundation.
* **AI Settings** — active strip select switches managed ↔ BYOK; setup cards only browse. Account tab shows read-only AI / storage / appearance glance. OpenRouter BYOK has model picker + pricing.
* **DB availability UX** — pool `connectionTimeoutMillis` 5s; `/health` includes `database`; API maps outages to `503 DATABASE_UNAVAILABLE`; web banner + auth-gate hold (no false sign-out); pg pool reconnects on next checkout.
* **Deploy scaffolding** — Atlas API-only compose; soft-boot without native engine; `@opensuite/engine` via npm (local `pnpm.overrides` → sibling link). See `docs/deploy.md`.

## Just Completed

* **Phase 2B.2 mutation contract correctness** — root causes: (1) `toNativeTextTarget` wrongly subtracted 1 from occurrence → `TARGET_NOT_FOUND` when model used inspect’s 0-based values; (2) permissive `set_table_cells_text` schemas let malformed updates throw in the TS bridge → `DISPATCH_FAILED`. Fixed pass-through + closed schemas + arg validation. Proven E2E: style / text formatting / table cells against real N-API fixtures.

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
| engine-client bound-docx mutation tests | Pass (13) |
| agent-core-v2 document tool tests | Pass (15) |
| API document-mutation-contract tests | Pass (2) |
| git diff --check | Pass |
| Manual Agent panel dogfood (mutation tools) | pending (user) |

## Intentionally Deferred

* Semantic document map / get_context / compaction / recovery / Progress Ledger
* Parallel sibling tool execution
* Engine keepNext/keepLines/lineSpacing/indent fields
* Frontend exposure of model-turn logs
* First npm publish of `@opensuite/engine` (needs `NPM_TOKEN` + `@opensuite` scope)
* Phase 2B.3 — repeated inspect/find, failure fuse, turn efficiency, history contamination

## Recommended Next Step

Manually dogfood Agent mutations (`set_table_cells_text`, `set_paragraph_style`, `set_text_formatting`) with zero-based occurrence / cell handles, then Phase 2B.3 efficiency.
