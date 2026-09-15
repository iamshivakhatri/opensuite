# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Core V3-1 (live)** — capability-aware system instruction from actual exposed `AgentToolSet` keys; `document.capabilities` removed from model tools (internal engine gating unchanged). Finish tool + soft stopReasons. Product SSE unchanged.
* V2 package retained off-path for rollback until mutation dogfood; duplicate tool defs still in `packages/agent-core-v2`.
* Deterministic V3 eval baseline: `pnpm agent:v3:eval` (6 scripted scenarios, no API key).
* AI Settings, DB availability UX, deploy scaffolding — unchanged. See `docs/deploy.md`.

## Just Completed

* **V3-1** — drop model-facing `document.capabilities`; `buildAgentOperatingInstruction(toolNames)` lists only gated document ops; execution passes `Object.keys(tools)` into system.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` builds API workspace deps first (`api^...`).
* Managed AI gateway = OpenRouter; **Agent Core V3** owns the model/tool loop; API owns app shell + document binding + persistence + operating instruction + background-run containment.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).
* Managed model is server-chosen (`OPENROUTER_MODEL`); users do not pick it.
* Agent runs: valid BYOK preference wins; otherwise OpenSuite managed trial.
* `/health` stays HTTP 200 while the API process is up; clients read `database` / `status` for outages.
* Hosted signup closed by default (`ALLOW_SIGNUP=false` in compose); open locally (default `true`).
* Local engine: root `pnpm.overrides` links sibling `opensuite-engine`; Docker defaults to stub until npm publish.
* Delete V2 only after successful Agent Panel mutation dogfood.

## Verification Status

| Check | Status |
|---|---|
| agent-core-v3 unit tests | Pass (13) |
| `pnpm agent:v3:eval` | Pass (6/6) |
| API operating-instruction + mutation-contract + isolation/version | Pass |
| Manual “what can you do” (0 tool calls) | pending (user) |
| Manual mutation dogfood (V3) | pending (user) |

## Intentionally Deferred

* Delete agent-core-v2 + duplicated V2 document-tools
* Transcript compaction / projectMessages host policy
* Semantic document map / indexing / recovery
* Custom retry classifier; prompt caching
* Frontend exposure of model-turn logs
* First npm publish of `@opensuite/engine`

## Recommended Next Step

Manual dogfood: “Hi, what can you do for me?” (expect 1 turn, 0 doc tools), then a real replace_text / formatting edit with version advance; then delete V2.
