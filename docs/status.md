# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V3-0 (live)** — API runs `@opensuite/agent-core-v3` (`runAgent` + finish tool + soft stopReasons). DOCX model tools live in `apps/api/src/agent/document-tools.ts` as V3 `AgentTool`s (`kind` read/mutate). Product SSE contract unchanged.
* V2 package retained off-path for rollback until manual dogfood; duplicate tool defs still in `packages/agent-core-v2/src/document-tools.ts`.
* Deterministic V3 eval baseline: `pnpm agent:v3:eval` (6 scripted scenarios, no API key).
* AI Settings, DB availability UX, deploy scaffolding — unchanged. See `docs/deploy.md`.

## Just Completed

* **V3-0 live cutover** — workspace dep; API document-tool port; execution uses V3 + `isSuccessfulStop` (max_turns/deadline → failed, not completed); finish tool + small system instruction; isolation/version/mutation-contract tests; eval harness.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` builds API workspace deps first (`api^...`).
* Managed AI gateway = OpenRouter; **Agent Core V3** owns the model/tool loop; API owns app shell + document binding + persistence + background-run containment.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).
* Managed model is server-chosen (`OPENROUTER_MODEL`); users do not pick it.
* Agent runs: valid BYOK preference wins; otherwise OpenSuite managed trial.
* `/health` stays HTTP 200 while the API process is up; clients read `database` / `status` for outages.
* Hosted signup closed by default (`ALLOW_SIGNUP=false` in compose); open locally (default `true`).
* Local engine: root `pnpm.overrides` links sibling `opensuite-engine`; Docker defaults to stub until npm publish.
* Delete V2 only after successful Agent Panel dogfood.

## Verification Status

| Check | Status |
|---|---|
| agent-core-v3 unit tests | Pass (13) |
| `pnpm agent:v3:eval` | Pass (6/6) |
| API isolation + version + mutation-contract | Pass (13) |
| engine-client bound-docx (sample) | Pass |
| git diff --check | Pass |
| Manual Agent panel dogfood (V3) | pending (user) |

## Intentionally Deferred

* Delete agent-core-v2 + duplicated V2 document-tools
* Transcript compaction / projectMessages host policy
* Semantic document map / indexing / recovery
* Custom retry classifier; prompt caching
* Parallel product redesign beyond V3 read concurrency
* Frontend exposure of model-turn logs
* First npm publish of `@opensuite/engine`

## Recommended Next Step

Manually dogfood Agent Panel mutations on V3 (`finish` termination, fuse, version advance), then delete V2 + the leftover V2 `document-tools` copy.
