# OpenSuite — Agent Instructions

## Product

OpenSuite is an open-source, AI-native Office workspace. DOCX is the connected editing path today; PPTX and XLSX can be stored but do not have connected editors or agent operations. The separate Rust `opensuite-engine` preserves untouched document content while applying deterministic, typed operations. The agent inspects, plans, asks the engine to edit, and checks the saved result. OpenSuite is a document product, not a general chat or coding agent.

## Repository map

| Path | Owns |
| --- | --- |
| `apps/web` | Next.js workspace, editor, agent panel, and product UI |
| `apps/api` | Fastify routes, auth, OpenSuite agent context/tools, persistence, validation, and run lifecycle |
| `packages/agent-core-v3` | Generic model and tool loop; no OpenSuite document rules |
| `packages/engine-client` | Thin TypeScript/Node bridge to the Rust engine |
| `packages/db` | PostgreSQL client, Drizzle schema, and migrations |
| `packages/contracts` | Shared types and engine contracts |
| `opensuite-engine` (separate repository) | Deterministic Office parsing, targeting, mutation, validation, and serialization |

`agent-core-v2` is retained off the live path. Do not expand it during unrelated work.

## Ownership rules

- Rust owns document semantics. `engine-client` is the only product package that talks to it. Send mutations as typed engine operations; never parse or edit Office XML in web/API TypeScript.
- `agent-core-v3` owns only the generic model/tool runtime. It must not access DB, storage, auth, UI, or Office internals.
- The `apps/api/src/agent` layer owns OpenSuite context, retrieval, document tools, persistence, validation, and run lifecycle. `apps/web` owns product and UI behavior.
- Keep Cloud-only business policy out of public core packages. Do not give the document agent arbitrary shell or filesystem tools. Major architecture changes need explicit user approval.

## Agent execution map

`server.ts` starts `runtime.ts`; `app.ts` creates services and registers routes. A run follows:

`routes/agent.ts` (HTTP/SSE) → `run-manager.ts` (live run and event subscriptions) → `execution.ts` (run flow) → `agent-context.ts` + `document-retrieval.ts` (history and evidence) → `docx-tools.ts` + `document-tools.ts` (typed tools) → `agent-core-v3` (model/tool loop) → `run-events.ts` (events and report) → `docx-tools.ts` (save) + `document-verification.ts` (check) → `run-settlement.ts` (terminal status and transcript).

`engine-client` calls the Rust engine for DOCX inspection and mutation. The API saves the edited DOCX as one new immutable version at the run boundary. The run manager repairs abandoned runs after a process restart.

## Frontend map

- `workspace-route-shell.tsx`: persistent workspace route and document loading.
- `workspace-ide.tsx`: tabs, explorer, editor/agent layout, and workspace actions.
- `surfaces/docx-surface.tsx`: DOCX editor bytes, save, and working preview.
- `document-agent-panel.tsx`: threads, run state, submit/cancel, and SSE.
- `agent-transcript.tsx` and `agent-composer.tsx`: adjacent display and input components.
- `lib/api-client.ts`: shared HTTP transport and errors; `lib/api.ts`, `ai-settings-api.ts`, and `storage-api.ts` own feature requests.

## Coding principles

- Read `docs/status.md` first, then the code to change. Read only the relevant durable docs: `docs/architecture.md` for boundaries, `docs/agent_core.md` for runtime, and `docs/engine_integration.md` for the engine.
- Use simple names and code. Keep the main workflow visible in its main file; put details in nearby modules named for their responsibility. Avoid file-per-function layouts and vague `utils`, `helpers`, or `common` modules.
- Do not build a framework around the existing runtime or split a cohesive file just because it is large. Minimize production code and avoid unrelated refactors.
- Preserve engine boundaries and existing behavior. For a behavior-preserving refactor, verify that behavior actually stays the same.
- Preserve the `opensuite_v4_modern_minimal.html` frontend hierarchy, spacing, proportions, and minimal style.

## Agent/runtime approach

**DISCOVER CHEAPLY → INSPECT NARROWLY → BATCH → MUTATE DETERMINISTICALLY → VERIFY → MODEL AGAIN ONLY IF NEEDED.**

Execute obvious safe actions quickly. Inspect and reason when a target is ambiguous. After failure, inspect only the relevant area. Keep these as guidance for current work; do not describe proposed runtime features as implemented.

## Verification

- API: `pnpm --filter @opensuite/api typecheck`; web: `pnpm --filter @opensuite/web typecheck`.
- V3: `pnpm --filter @opensuite/agent-core-v3 typecheck` and `pnpm --filter @opensuite/agent-core-v3 test` when touched.
- Focused API test: `pnpm --filter @opensuite/api build && node --test apps/api/dist/agent/execution.isolation.test.js` (change the test path as needed).
- Engine bridge: `pnpm --filter @opensuite/engine-client test` when touched; run Rust tests in the separate `opensuite-engine` checkout when Rust changes.
- When upgrading `@opensuitehq/engine` (or after an engine `v*.*.*` publish), update in the same change: `packages/engine-client/package.json` (exact version), `pnpm-lock.yaml` (confirm package and snapshot entries include published Linux `x64-gnu` and `arm64-gnu` optional binaries; a macOS-generated lockfile can omit them), `pnpm-workspace.yaml` `minimumReleaseAgeExclude` for the engine and platform packages, and version pins/comments in `Dockerfile`, `docker-compose.atlas.yml`, `docs/deploy.md`, `docs/engine_integration.md`, plus any `docs/status.md` / `docs/agent_core.md` lines that state the pin. Before deployment, build the API Docker image for the target Linux architecture and require the Dockerfile's engine-load check to pass. Do not deploy an image that lacks its native binding.
- Before finishing: `git diff --check`. Do not run paid model calls unless asked.

Update `docs/status.md` concisely after meaningful work. Report changes and checks; recommend one next step without doing it unless asked.

## Git identity

When committing, use the user's existing Git `user.name` and `user.email`. Do not set agent author/committer variables or add AI/Cursor attribution or `Co-authored-by` trailers.
