# Phase 5: Context preservation and repeated reads

## Context lifecycle and changes

The active run already keeps the original request, provider-supplied reasoning, and assistant/tool exchanges in Agent Core. The live API does not use the older aggressive observation projector. Completed runs already contribute user-visible messages and compact run summaries to later requests, rather than full internal traces. These behaviors remain in place; persistent diagnostics are not deleted.

Two concrete gaps were fixed:

- `apps/api/src/agent/execution.ts`: the old read counter could suppress different reads without pointing to a matching full result. The replacement checks exact tool arguments and document ID, saved version, and working revision against successful observations still in the current transcript. Only `document.inspect`, `document.find`, and `document.style_snapshot` qualify. Each repeated call retains its identity, arguments, ordering, and a result explicitly stating that no native read executed, with `originalToolCallId` pointing to the full observation still in model input. There is no separate cache or storage.
- `apps/api/src/agent/agent-context.ts`: initial retrieval maps and source references previously disappeared after the first internal turn. They now remain at a fixed position, labeled as historical context after edits. The existing complete document view continues to refresh after edits and is omitted when refresh fails. Continue retrieves against the original task and restores its attached document IDs, alongside existing target, saved-version, capability, progress, and failure metadata.

Changed arguments, edits, version or document changes, intervening unknown tools, malformed tool/result pairs, failures, nonempty diagnostics, and ambiguous or empty search results require fresh native reads. A first full observation is never replaced. Mutation calls, results, errors, and provider reasoning remain intact.

## Deterministic comparison

The same scripted provider, native DOCX fixtures, and runtime configuration were run against Phase 4 production code and the changed code. Input estimates use serialized SDK prompts and tool schemas; they are not billed provider tokens. Native read counts below include the identical validation reads in A–F. Duplicate bytes measure selected repeated tool-result payloads in the final model request. G counts native style reads specifically.

| Scenario | Estimated total input, before → after | Peak input, before → after | Native reads, before → after | Repeated payload bytes, before → after |
| --- | ---: | ---: | ---: | ---: |
| A: KPI edit | 47,060 → 47,215 | 18,909 → 18,978 | 16 → 16 | 0 → 0 |
| B: unchanged inspection | 84,372 → 66,408 | 28,195 → 19,170 | 17 → 16 | 27,525 → 244 |
| C: read after edit | 74,970 → 75,221 | 28,107 → 28,201 | 17 → 17 | 0 → 0 |
| D: ambiguous heading | 38,639 → 38,911 | 9,928 → 10,021 | 17 → 17 | 328 → 400 |
| E: global styling | 333,744 → 253,838 | 52,589 → 33,624 | 22 → 19 | 58,052 → 733 |
| F: failed edit and recovery | 65,878 → 66,103 | 19,034 → 19,103 | 16 → 16 | 0 → 0 |
| G: turn limit and Continue | 340,456 → 277,886 | 23,158 → 15,216 | 18 → 2 | — |
| H: independent request | 8,867 → 8,884 | — | — | — |

Model turns are unchanged: A 3; B/C/D/F 4 each; E 12; G 20 plus one Continue turn; H 1. Read calls issued remain A 1, B/C/D 2 each, E 7, F 1, G 18 style reads. The same calls stay observable even when their results refer to earlier evidence. B avoids one native read, E three, and G sixteen.

Native mutations remain A/B/C/D/F 1 each, E 3, G 2, H 0. A–F each save one version; G saves two; H saves none. F retains one failed edit and its successful retry, classified as recovered. Other scenarios have no tool errors. All reopened documents have the expected text, table cells, and formatting. D changes the actual Heading 1 paragraph while preserving the contents entry; E verifies the global style, paragraph alignment, and text emphasis.

Metadata and retained evidence add less than 1% estimated input to the cases without reusable reads. No additional model turns, mutations, saved versions, or database queries were introduced.

## Preservation and regression evidence

The benchmarks assert matching tool-call/result IDs and ordering, the original task throughout active execution, the first full observations, successful mutations, failed edits and recovery, and provider-supplied reasoning. Read-after-edit and state-change tests prevent stale reuse. Focused guard tests cover changed arguments, unique versus ambiguous searches, warnings, errors, missing context, document/version/revision changes, and malformed history.

The bounded task keeps its request and evidence through 20 turns, saves its style change, and Continue uses the saved version and restored tools to finish the remaining edit without repeating that mutation. The subsequent independent request retains final visible replies without the prior tool calls, results, raw schema observation, or provider reasoning.

Validation passed:

- API: typecheck and build; 442 tests passed, 23 configuration-dependent skips, zero failures.
- Agent Core: typecheck and build; 40 tests passed.
- Engine client with the existing local native binding: build; 39 tests passed, 2 skips.
- Cloud: typecheck and build; 9 tests passed, 2 skips.

The API suite includes prior target activation, error recovery, handle/version safety, capability restoration, document creation, multiple documents, authorization/workspace isolation, cancellation, turn limits, and saved-version checks. No engine source, native dependency pin, UI, migration, or configuration changes were needed.

## Remaining limits

Live-model latency, cost, and task completion are unverified. Distinct large observations can still grow beyond a provider context limit; this phase adds no arbitrary truncation. Argument matching is exact, not semantic, and concurrent reads in the same turn are not deduplicated.

Continue restores existing durable task/run metadata, not the complete prior raw tool transcript. Full arguments and observations are available in active memory and optional local full traces, rather than the compact durable run steps. Handles are scoped to a new run and must be read again. General progress replay, mutation recovery, and richer Continue handling for cancellation or recoverable failure remain Phase 6 work; current automatic continuation reconstruction covers turn-limit/deadline stops. No cleanup treats those other unfinished outcomes as safely completed.

Unrelated local UI edits were preserved. Phase 5 is committed separately; nothing was pushed or published.
