# Phase 4: efficient capability discovery

Implemented and checked locally on October 12, 2026. No paid model calls, push, engine release, or dependency-pin changes.

## Findings and changes

- Search/list returned the same shape for browse-only domains, loadable groups, individual tools, and active tools. For example, `styles` appeared in a style search but could not be loaded. IDs themselves matched the registry; the missing loadability distinction made otherwise valid results misleading. Results now include `kind`, `loadable`, and `loaded`, omit repeated titles/tool-name descriptions, and bound other descriptions to 160 characters.
- Invalid loads returned only a reason code. They now identify rejected IDs and offer up to eight exact available/loadable children or siblings. No identifier is silently renamed. A batch with an invalid ID still leaves the session unchanged. Saved-style restrictions also affect advertised loadability.
- Loaded groups already stayed available within a run. One tool registry entry per name and a set of active names already prevented duplicated schemas. Loading a leaf ID already exposed just that tool; loading a group exposed its available members, without automatically loading companion groups. These rules remain unchanged.
- The model previously received a per-turn summary of loaded instruction bodies, but no compact summary of loaded tool IDs. The existing projection now includes loaded IDs once per request, within its token budget and outside the durable transcript. Identical searches still use the existing index; repeat calls remain possible and do not grow the tool surface. No search cache or general call suppression was added.
- Continue created a new empty session. The existing final step now saves loaded IDs beside the selected document ID. Continue reads those steps through its existing owner/thread checks, restores IDs through the current tool bindings, and uses the original request's saved-style policy. Removed/unavailable/non-loadable IDs are skipped. The restored schemas are included in the initial context budget. Selected-document ownership/workspace/current-version checks remain unchanged.
- Search is bounded to eight matches and list returns immediate available children. Some searches are broad because they match both operations and guidance. The new state fields make this explicit; loaded state is derived from the existing active names and instruction set, including tools activated through a group.
- Large surfaces come from explicit group loads, not speculative loading or schema duplication. The existing report-style companions cover table, text, paragraph, and layout groups. Loading these plus style inspection can approach the reported 41 tools. The original 38-turn trace was not supplied, so its exact sequence and model decisions cannot be verified. Model behavior can still cause repeated list/search calls.

Production changes are confined to five files under `apps/api/src/agent`: `capabilities/core/session.ts` (discovery/error contracts), `capabilities/runtime/tool-surface.ts` (short tool descriptions), `capabilities/runtime/instruction-projection.ts` (loaded-ID summary), `execution.ts` (safe restoration and budgeting), and `run-events.ts` (existing step metadata). Existing test files cover the contracts and native DOCX execution. No registry, engine, Agent Core, Cloud, or UI production code changed.

## Deterministic measurements

The baseline uses the pre-change production code from Git HEAD; both runs use the same scripted behavior, generated fixtures, runtime settings, and local native engine. A–D use fixed calls; global styling deliberately repeats one search and one list. E first reaches the real 20-turn bound, then uses the current tool list to decide whether discovery is needed. The baseline saved DOCX checks pass; its new zero-rediscovery assertion fails as expected.

Input figures below are sums of the existing `estimateTokens` function applied to each actual provider request's serialized prompt and schemas. They are estimates, **not actual provider token usage**. The scripted model reports dummy usage; live tokens, latency, and cost are unverified.

| Scenario | Discovery-only turns, before → after | Repeated identical list/search calls | Peak tools | Peak schema characters, before → after | Estimated input tokens, before → after |
| --- | --- | --- | --- | --- | --- |
| A: KPI cell edit | 0 → 0 | 0 → 0 | 21 → 21 | 17,218 → 17,138 | 19,156 → 19,103 |
| B: header formatting | 2 → 2 | 0 → 0 | 22 → 22 | 21,128 → 21,048 | 41,559 → 41,495 |
| C: global Word style | 3 → 3 | 2 → 2 | 23 → 23 | 19,930 → 19,850 | 75,247 → 74,190 |
| D: comments + tracked replacement | 2 → 2 | 0 → 0 | 25 → 25 | 20,836 → 20,756 | 55,077 → 54,747 |
| E: Continue (resumed run only) | 1 → 0 | 0 → 0 | 22 → 22 | 18,798 → 18,718 | 18,516 → 9,555 |

Fresh initial surface: 21 tools in both versions; 17,218 → 17,138 schema characters. E total resumed model turns: 2 → 1; discovery calls: 2 → 0. A–D total turns remain 2/4/6/5. No unnecessary group loads or tool failures occur in A–E. Saved cell text, table-header formatting, native named-style formatting, comments, and tracked replacement are reopened and checked; each mutated run saves one version.

F and registry coverage: every advertised loadable inventory ID loads successfully; repeat loads add no schemas; active leaf/group state is accurate; invalid, unavailable, and browse-only IDs fail atomically with deterministic alternatives where available. Missing tools, deleted Continue targets, and unchanged selected-document restoration are covered. No `CAPABILITY_NOT_LOADABLE` occurs from an advertised loadable ID in these tests.

## Checks and limits

- API build/typecheck pass; full API tests: 443 passed, 23 DB/auth/configuration skips. Focused capability suite: 38 passed.
- Agent Core typecheck/build/tests: 40 passed. Local-engine client build/tests: 39 passed, 2 skips.
- Cloud typecheck/build/tests: 9 passed, 2 configuration skips.
- Phase 1 target activation/Continue, Phase 2 truthful recovery, Phase 3 handles/targeting, cancellation, persistence, creation, reference workflows, and authorization regression tests pass in the API suite.
- Phase 4 diff whitespace check passes. Whole-working-tree check reports existing CRLF whitespace in the unrelated `apps/web/src/app/globals.css`; that file and the user's other UI edits are preserved.

Older runs without a loaded-ID snapshot still start with the small default surface. Searches discovered but never loaded are not restored; no saved search cache exists. Current group definitions are revalidated when restoring, and instruction bodies come from the current registry. Improvement beyond compact results and restoration depends on model choices. General repeated reads/transcript compaction stay in Phase 5; broader Continue progress recovery and mutation batching stay in Phase 6. No new storage, telemetry service, configuration, or tool dependency graph was introduced.
