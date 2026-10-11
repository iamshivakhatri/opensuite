# Remediation Plan

_Source: read-only audit at OpenSuite `2115161`, Cloud `3780660`, engine `eab5c33`. This file lists every change the audit found and the order to do them in. Tick items as they land; delete this file once every phase is done or moved into `status.md`._

Labels: **Update** = change existing behavior, **Remove** = delete dead code, **Add** = new check, test, or signal.

## Phase order

| Phase | Goal | Depends on |
| --- | --- | --- |
| A | One engine capability/input definition, proven binary identity, verified release | — |
| B | Semantic table features covered through the product loop | A identity/support checks |
| C | Completion, validation, and accounting are truthful | can overlap B |
| D | Measure real-document results and reduce unnecessary work | A–C checks; sample collection can overlap |
| E | Smaller initial tool surface | D measurements |
| F | Remove dead paths, tighten Cloud parity | B–C coverage (Cloud LibreOffice can go earlier) |

Each step is one reviewable change with its own checks. Real-model runs require explicit approval.

## What to do next, in plain English

| Step | Phase | What it means | Current state |
| --- | --- | --- | --- |
| Define operation inputs once and generate agent tools | **A7** | The engine describes the required inputs for each operation. The product uses that description to build the agent's tool definition instead of maintaining another copy. | Mutation inputs, declarations, validation, and dynamic discovery implemented locally. Read-tool generation remains. |
| Release the engine, update the npm pin, and verify images | **A8**, with Cloud work in **F5–F6** | Publish a new engine package, make OpenSuite install that exact version, then build and check the public and Cloud containers that would run in production. | Not released. Local Cloud ARM64 candidate passed; remote build and real x64 checks remain pending. |
| Test 10 real reports and proposals repeatedly | **D1** | Keep a fixed set of realistic DOCX files and editing tasks. Compare saved results, preserved content/layout, speed, cost, and unnecessary agent steps before making further changes. | Manual browser/Word testing belongs to the user. Fixed document set and results remain pending. |

Recommended order: **A7 → A8 → D1 → measured D/E improvements**. Gathering the
D1 documents and defining their expected results can start alongside A7; there
is no need to wait for a release to collect examples. Ten documents is a useful
starting sample, not a claim that ten tests prove the product is ready.

Update this file after each work step: mark what changed, record the checks,
and distinguish implemented locally, published, and deployed. Leave unfinished
or unverified items unchecked.

## Phase A — Engine capabilities, inputs, and release checks

Original audit problem: the N-API manifest dropped `semantic_table_cell_targets` and `semantic_table_row_deletion` (the Rust protocol had them), so engine-client relied on `engineVersion >= 0.1.3`. The published 0.1.5 fixes those missing IDs. Loader overrides (`OPENSUITE_ENGINE_PATH`, `NAPI_RS_NATIVE_LIBRARY_PATH`, package-local `.node`, WASI flags) still mean the npm pin alone does not prove which binary ran; A5 verifies the selected binary. A6–A7 extend this work to one engine capability/input definition.

Do not change: target semantics, mutation algorithms, preservation, working-byte lifecycle. Keep the version fallback until every deployed engine advertises the IDs.

**Step A1 — advertise semantic IDs and log native identity** _(implemented; engine published in A3; identity edge case remains in A5)_
- [x] **Update** engine `crates/opensuite-node/src/lib.rs` `node_docx_capability()` to include both semantic IDs; add a Rust test. Published in 0.1.5.
- [x] **Add** engine-client `describeNativeEngine()`: resolved module path, loaded `.node` path, short SHA-256, set `NAPI_RS_*` loader overrides.
- [x] **Update** API startup `[engine]` log with binary, hash, overrides, and semantic support flags.

**Step A2 — native acceptance check** _(done)_
- [x] **Add** `packages/engine-client/scripts/native-acceptance.mjs` (`pnpm --filter @opensuite/engine-client native-acceptance`): fails on any override, checks wrapper version = engine-client pin = native `engineVersion`, required exports (via binding creation), semantic support, and in-memory create table → semantic header bold → shading → semantic cell text → semantic row deletion. Prints whether semantic IDs are advertised; does not yet require them.
- [x] **Add** `--allow-overrides` mode that reports the override's own identity (checked with `NAPI_RS_NATIVE_LIBRARY_PATH` and `OPENSUITE_ENGINE_PATH` → local build, which advertises both IDs).
- [x] **Update** public `Dockerfile` build stage runs the script (verified: Linux arm64 binding PASS). `docs/engine_upgrade.md` uses it.
- [x] **Update** removed the test assertion that 0.1.4 *omits* semantic IDs, and listed both IDs as non-mutation capabilities so the local engine build passes engine-client tests.

**Step A3 — publish and pin** _(done)_
- [x] Engine `2da9c9c` (manifest fix) + `f8c4c7e` (release prep) on `main`; tag `v0.1.5`; CI published all six `@opensuitehq/engine*@0.1.5` packages with provenance.
- [x] OpenSuite pinned to `0.1.5`: engine-client dependency, lockfile (all five platforms incl. Linux x64/arm64 GNU), `minimumReleaseAgeExclude`, Dockerfile/compose/deploy/integration/style-profile/status/`.env.example` pins, binding error strings, version assertions.
- [x] **Update** `native-acceptance.mjs` now requires both advertised semantic IDs. The `>= 0.1.3` version fallback stays in engine-client for older/override binaries.
- [x] Verified: host acceptance PASS (overrides unset); engine-client 34/34; API 413 pass / 2 known failures; full arm64 API image builds, acceptance PASS in build stage and runtime container, `soffice` present; npm 0.1.5 loads on linux/amd64 (`linux-x64-gnu`, both IDs). Full amd64 image build under QEMU crashes in libuv after `pnpm install` (emulation bug) — confirm on a real x64 builder at deploy.

**Step A4 — Cloud engine check matches runtime** _(done locally; remote release pending)_
- [x] **Update** public and Cloud `deploy/docker-entrypoint.sh` boot checks now use engine-client `createNapiDocxEngineBinding()` + `describeNativeEngine()` (honours `OPENSUITE_ENGINE_PATH` / `NAPI_RS_*`) and log version, binary, overrides; still warn-only. Verified in the public image: npm binary reported; a bad `OPENSUITE_ENGINE_PATH` now warns (old check said "engine ok").
- [x] **Add** Cloud `Dockerfile` public stage runs `native-acceptance.mjs` after the build. Cloud linux/arm64 candidate build passed from a clean archive of public commit `f01c31f8ba3260576603ee1846559891b8a2bb52` (only the GitHub fetch was replaced with this local source). Build-stage and finished-container native acceptance passed; Cloud runtime imports and real TOC/PAGE field refresh passed. The production GitHub-fetch build still requires that public commit to be pushed.

**Step A5 — identify the selected module's binary** _(done locally)_
- [x] **Update** `describeNativeEngine(binding)` follows the selected loader tree and matches the native function exports. The binding keeps its original identity even if environment variables change. Public runtime and both entrypoints share `formatNativeEngineIdentity()` (native version, resolved module, actual `.node`, full SHA-256, overrides). Runtime passes the same binding into the app. Tests cover old-before-new cache order, a nested loader, renamed/direct binaries, and changed environment. A real installed 0.1.4-before-0.1.5 check also passes.

**Step A6 — one engine capability inventory** _(done locally; next engine release required)_
- [x] Rust protocol `DOCX_CAPABILITIES` owns each ID, operation kind, Node export name, and Node availability. N-API reads this directly; the second allowlist is deleted. Feature flags stay separate from callable operations, and Rust-only aliases are not advertised to Node.
- [x] N-API adds `formats[].operations` with `{ id, kind, nodeExport }`. Engine-client checks that each advertised export exists. Published 0.1.5 remains supported without this optional field.
- [x] Loader export names come from Rust `#[napi(js_name)]` annotations. A missing TypeScript declaration stops loader generation. Node tests compare inventory, compiled exports, and declarations; matching-host release builds run this check.
- [x] Product contract tests require every engine capability to have a working agent schema/dispatcher/discovery entry or an explicit separate path (reads, creation, feature flags, binary assets). The new local inventory passes the real product tests. New capabilities cannot be silently skipped by this test.

**Step A7 — engine-owned inputs and generated agent tools** _(mutation path checked locally; read tools remain)_

The compiled Rust N-API inputs now generate TypeScript declarations and JSON
schemas. JSON schema is a machine-readable description of accepted inputs.
Descriptions and extra input restrictions live beside the Rust transport types.
The engine returns these definitions with its operation inventory. The product
still controls document access, dynamic loading, saving, and verification.

- [x] Generate input schemas, integer bounds, descriptions, and declarations from Rust N-API type records. Compile again to embed the generated schemas; native tests compare the compiled metadata with generated files. Unsupported input types stop the build.
- [x] Replace duplicated API mutation schemas and ordinary dispatch maps. Validate JSON arguments before calling native code; keep existing typed adapters, target guards, owned assets, saved versions, and verification.
- [x] Let newly advertised JSON mutations enter discovery under `document.more_operations`, with next-turn loading and no growth in the initial tool list. Native byte inputs remain hidden from the model.
- [x] Support published 0.1.5 with a generated compatibility snapshot. Refresh it with `node packages/engine-client/scripts/update-docx-inputs.mjs ../opensuite-engine/crates/opensuite-node/index.js`; never edit its schemas by hand. New engines supply their live definitions.
- [ ] Extend engine-generated inputs to the product's read tools and verify newly added reads can be discovered and called. Existing high-level read tools still use product schemas.
- [ ] Verify packaged consumers and platform builds before A8 publication. No new version has been published or deployed.

Local checkpoint checks: API/dependency build passes; API 428 pass / 23 database
skips; engine-client 37 pass / 2 optional skips; native 35 pass; changed Rust
crates lint cleanly and their 7 tests pass. Selected local-engine mutation and
discovery checks pass. Browser/Word testing remains with the user.

**Step A8 — release and production-image verification** _(after A7; not released)_

Changing local Rust files does not change the engine installed by the product.
The npm pin is the exact package version OpenSuite installs. A production image
is the built container containing the API, native engine, and required programs.

- [ ] Release the reviewed engine changes under a new, unused npm version using the engine's `docs/releasing.md`; verify the published platform packages.
- [ ] Update OpenSuite's exact npm dependency and lockfile using `docs/engine_upgrade.md`, including platform packages, release-age exclusions, and operational version references.
- [ ] Build and check the public image with engine overrides unset: native version, selected binary/hash, advertised operations, and semantic edits must pass.
- [ ] Publish the reviewed public commit and update Cloud's single `deploy/opensuite-ref` pin (**F6**). Build Cloud through its real GitHub-fetch path; verify native edits and LibreOffice field refresh (**F5**) in the finished container.
- [ ] Verify on real Linux x64 and ARM64 builders. The local ARM64 candidate and npm x64 load check do not prove a complete production x64 build.
- [ ] Record release and image evidence here. Mark deployment separately, only after it actually happens.

A5 and local Cloud candidate checks pass. Remote release/deployment checks remain pending; pushing alone is not deployment evidence. The new inventory must be released under a new engine version before npm consumers receive it.

## Phase B — Semantic features through the product loop

Problem: engine support does not prove agent exposure, sequencing, saved output, or truthful settlement.

Files: `document-tools.ts`, `docx-tools.ts`, execution/validation/settlement tests. Do not add a planner or redesign retrieval.

_(done)_ Tests live at the end of `apps/api/src/agent/execution.isolation.test.ts`, driven by `runScriptedDocx()` (real agent-core loop + real native engine; only the model is scripted).

- [x] **B1 Add** create table + `capabilities.load` of `document.tables.styling` → semantic header bold + shading → one save. Asserts the styling tools appear only on the next turn, every tool call succeeds, the report says success, and the reopened DOCX has the table text, two `D9E2F3` header fills, and bold header runs. Also semantic row deletion by label (saves once, row gone).
- [x] **B2 Add** failure cases:
  - successful create + failed semantic shading (`TABLE_COLUMN_NOT_FOUND` from the engine, not the app gate) → `AGENT_PARTIAL_COMPLETION`, one save, no fill;
  - failed semantic formatting alone → `AGENT_MUTATION_FAILED`, no save;
  - empty no-tool final response → covered by **C1**, with no `todo`;
  - failed cell edit then success on a different cell with the same tool → covered by **C2**, with no `todo`.
- The "Add a table to this document" target-binding gap is fixed and covered by **C10**.

## Phase C — Completion, validation, and accounting

Do not change: credit pricing, mutation scheduling, safe partial-save behavior.

- [x] **C1 Update** no-tool completion settles only the terminal turn's text; when it is empty the API settles "Saved the changes to …" (or "Done."). The B2 test is no longer `todo`.
- [x] **C2 Update** agent-core carries opaque `effectKeys(input, output)` on metrics; recovery stays in the API. A failed unit requires a later same-tool success matching the exact target **and** requested change. Document identities include the bound document ID, exact handles, case, and spacing; `expectedCurrentText` and `baseRevision` are guards rather than requested changes. Target-only/effect-only matching, earlier-success matching, and tool-name fallback are removed. Missing identities or changed selectors remain unresolved. Added regression coverage for identical formatting on different cells, different replacements on one target, case/spacing, picture handles, batch suffixes, and missing identities; a corrected guard for the exact same edit still recovers. Scripted real-loop tests retain separate immutable before/after bytes and verify partial settlement, saved output, and truthful report recovery flags. Known limit: corrected selectors/fresh handles and tools without work identities can remain partial even when the model believes it recovered; proving those cases needs stable target evidence, not guessing.
- [x] **C3 Update** `sources` is non-blocking: runs never write sources, so a changed source is a concurrent edit and reports as a `warning`. Documented on `BLOCKING_VERIFICATION_IDS`; execution's hand-copied blocking list (missing `notes`, `verification`) now uses the shared set.
- [x] **C4 Update** usage is recorded at most once per run on every terminal path (success, partial, failed verification, bounded stop, model error, cancellation). Failure paths skip empty usage and log accounting errors instead of masking the run's failure. Managed debit stays keyed by usage event, so once-per-run is idempotent.
- [x] **C5 Update** thread-title and context-compaction calls go through the shared `usage-accounting.ts` `recordModelUsage()`.
- [x] **C6 Update** on success, usage settles before the run report; a managed-credit failure reports the run as failed and then settles it as failed.
- [x] **C7 Update** protected parts are `customXml/`, `word/embeddings/`, `word/glossary/` (the old regex never matched `word/…`), and zip directory entries are ignored (they made any package with directory entries fail the gate). The test covers all three parts.
- [x] **C8 Add** one terminal-path matrix test in `execution.isolation.test.ts` (real loop + real engine, scripted model): success, model error after a saved edit, model error before any work, cancellation after an edit, failed verification, managed-credit failure after saved work, credit failure during a model error. Each case asserts the durable run status/code, exactly one usage event attributed to the run with the right tokens, one managed debit per usage event, saves and `document.version.advanced` count, exactly one terminal SSE event, one run report with the right outcome, the assistant reply, and what the next turn's history says. Removing the once-per-run usage guard makes it fail (double billing). Partial runs and recovery rules were already covered.
  - **Fixed (found by C8):** a thrown failure after a version was saved (model error, credit failure) settled as "Agent execution failed. Please try again." with no mention of the save, both on the run and in the next turn's history, inviting a duplicate retry. `settleTerminalRunFailure` now takes `changesPreserved` and appends "Changes made so far were preserved." (not for `AGENT_PERSISTENCE_FAILED`, not when already said). `versionAdvances` moved to run scope so the outer catch can see it.
  - **Open decisions (not changed):** (1) a usage-ledger insert failure (BYOK) or managed debit failure after saved, verified work still settles the run as `failed`, now with the preserved note — consider `completed` + an accounting alert instead; (2) a cancelled run that saved a version has no durable message (history shows `status: cancelled` and the tools used); (3) usage is recorded once at run end, so a process crash mid-run (repaired as abandoned) bills nothing — per-turn recording would fix it but changes debit granularity.
- [x] **C10 Update** `refersToOpenDocument()` binds edit verbs (add/insert/remove/delete/replace/bold/shade/fix…) followed by "this/current/open document|doc|file|report", "in this document, <verb>", and "remove … from this document"; "from/using/based on/like this document" stays a source. Cases added to `workspace-manifest.test.ts`.
- [ ] **C9 Remove (later)** legacy `loadHistory()` fallback that uses a following assistant row when the linked result is absent — only after confirming no old rows depend on it.

## Phase D — Real-document baseline and context/decision overhead

Do not strip same-run provider reasoning/tool exchanges or weaken target safety.

- [ ] **D1 Add** a fixed starting set of **10 real DOCX reports, proposals, and branded documents**, with specific edits and expected results. Reuse the same files/tasks when comparing changes. Tasks should include updating reporting dates and KPI tables, replacing proposal details, applying a saved style, and keeping branding and untouched content intact. Check saved text/tables/styles, untouched package content, visible layout, and truthful success/partial/failure messages. Record model turns, time to first useful tool, total duration, context/schema size, redundant reads, and cost. Start with scripted/replayed responses; collecting or running paid model responses requires explicit approval. Use the results to choose D/E improvements; this baseline does not itself add new product features.
- [ ] **D2 Add** observability: full request duration (retrieval, save, validation, settlement), save/DB timing, validation timing, tool count/schema chars in the persisted run report, SDK retry counts.
- [ ] **D3 Update** skip candidate map/evidence work when DIRECT is complete, if D1 shows it is unused.
- [ ] **D4 Update** rename `plannerEvidence*` → `documentContext*` and `hierarchical` mode → `document_maps`.
- [ ] **D5 Update** pass `deadlineMs` from API execution to agent-core if a wall-clock limit is wanted.
- [ ] **D6 Update** make `workspace.inspect_document` on the active target either read working bytes or say it shows the saved tip.

## Phase E — Initial tool surface (21 tools today)

Do not change authorization, target binding, or engine operations.

- [ ] **E1 Add** snapshot tests of exact initial schemas for read, edit, create, saved-style, engine-unavailable cases.
- [ ] **E2 Update** reassess "always" catalog membership; check whether both `capabilities.list` and `.search` are needed every request; avoid loading overlapping single/batch tools together.
- [ ] **E3 Update** make `render_layout` availability depend on the external renderer, not only `layout_snapshot`.

## Phase F — Dead paths and Cloud parity

Do not change DB history, migrations, the public runtime seam, or stable contracts casually.

- [ ] **F1 Remove** `agent/in-run-observation-projection.ts` and its tests; replace fixtures in `run-trace.test.ts`.
- [ ] **F2 Remove** `engine-client` `engine-client.ts`, `transport.ts`, `mock-transport.ts` and tests after checking exported-contract consumers.
- [x] **F3 Remove** `packages/agent-core-v2` entirely (no production imports) and **rename** `agent-core-v3` → `packages/agent-core` / `@opensuite/agent-core`. Also renamed `V3Model` → `AgentModel`, `ResolvedV3ExecutionModel` → `ResolvedExecutionModel`, `[agent-v3]` logs → `[agent]`, `agent:v3:eval` → `agent:eval`; dropped the `[agent] runtime=v3` boot line. Kept the persisted `v3-<runId>` assistant message-id prefix. Updated API deps/tsconfig, lockfile, public `Dockerfile`, Cloud `Dockerfile`, and docs. **Deploy order:** publish the reviewed public commit first, then Cloud — its default source now comes from `deploy/opensuite-ref`, and copied paths use `agent-core`.
- [ ] **F4 Update** share one TOC-refresh predicate between `field-refresh.ts` and verification.
- [x] **F5 Add** LibreOffice (`libreoffice-writer-nogui` + `fonts-dejavu-core`) to Cloud runtime. Candidate linux/arm64 image contains Writer 7.4.7.2 / DejaVu Sans; real dirty TOC/PAGE field refresh passes offline as the runtime user.
- [x] **F6 Update** Cloud defaults to the one SHA in `deploy/opensuite-ref` (`f01c31f8ba3260576603ee1846559891b8a2bb52`). Compose leaves the override empty. Docker accepts only a full 40-character SHA and verifies fetched HEAD; a build with `OPENSUITE_REF=main` is rejected. Default remote fetch remains unverified until this local public commit is pushed.
- [ ] **F7 Update** Cloud: one source pipeline for the overlay (no hand-maintained JS beside TS); remove duplicated report persistence in `production-server.js`.
- [ ] **F8 Update** move credit/display-grant vocabulary and legacy managed-trial codes out of public core where possible.
- [ ] **F9 Update (optional)** rename `docx-tools.ts` → `document-session.ts`; split binding contracts from the binding implementation in `docx-engine-binding.ts`.
- [ ] **F10 Add** Rust-provided package-preservation facts so API field refresh stops classifying Office parts itself (needs engine work; scope separately).
- [ ] **F11 Review** startup lease clearing + process-local run hubs before running multiple API instances.

## Known failing tests

None. Both stale tests were fixed during Phase C: the mutation-contract test now ignores read tools such as `document.inspect_comments`, and the KPI skill test expects the intentional `logo` brand channel (commit `c73c298`).

## Not touching

Rust mutation/preservation algorithms; the run-local working bytes and single-save boundary; ownership checks and optimistic version concurrency; the document/workspace tool split; same-run provider continuation; the `createOpenSuiteRuntime` Cloud seam; DIRECT fallback; historical migrations and compatibility gates; folder structure before Phases B–C close.
