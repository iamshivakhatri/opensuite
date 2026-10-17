# C2 attachment workflow stabilization

## Causes and changes

- The web panel already passes `activeDocumentId` separately from tagged workspace
  sources. The API intentionally avoids binding reference-only files, but also
  missed an explicit current target in “update the report using the attached
  PDF” or “revise it based on …”. These now bind the owned open file before the
  first model request when there is no competing named/tagged target. New-file,
  another-file, multiple-file and ambiguous requests remain unbound.
- `workspace.select_document` was already a mutation. Core executed all reads
  first, so same-turn inspection ran before selection. A small optional
  `beforeReads` flag now orders selection before reads. Earlier mutations retain
  their order, selection failure skips dependent work, independent reads remain
  concurrent, and provider transcript/result ordering is preserved.
- Validation inferred sources from working-document membership and compared
  workspace saved versions only. It could skip a chat-only PDF or pass an empty
  workspace-source set without checking that PDF. The API now records actual
  supplied/read source references. Workspace checks compare authorization, saved
  version, draft token and byte hash. Attachment checks reauthorize, compare ID,
  original SHA-256 and extraction ID, require the recorded extraction cache, and
  hash the stored original bytes even when extraction was cached.
- Validation distinguishes verified identities, unavailable verification,
  changed/deleted/unauthorized sources, and no source. It retains bounded
  page/section locations and selected visual references. Reader observations
  retain their source reference, model and a hash of the recorded interpretation;
  verification checks their source hash/extraction identity. Identity verification
  does not prove the interpretation or updated prose is factually correct.
- First source identities survive the existing same-task Continue payload as
  compact references, without filename/size metadata or source contents. A new read
  cannot replace an older reference and hide a change. Legacy replay lacking
  source identities warns rather than asserting verification. No database schema,
  service, general historical-evidence system or engine change was added.
- Discovery guidance explicitly uses an exposed tool directly and loads a known
  ID directly. Existing manifest evidence, exact-read reuse, dynamic loading,
  hidden-tool rejection, and schema budgets remain intact. No catalogs were
  preloaded, useful history trimmed, or context compacted.

Source warnings remain non-blocking, matching existing product policy: a save may
use evidence read earlier, with the changed/unavailable source recorded as a
warning. The target/save/structure checks remain separate and blocking.

## Deterministic comparison

The same adaptive mocked-model policy and temporary BluePeak PDF/DOCX fixture ran
against HEAD before this change in a separate temporary checkout and against the
updated code. Both use real PDF extraction, the installed native engine, one
saved version, and unchanged unrelated paragraph wording and style facts.
The original dogfood files and production trace were not present locally.

| Measurement | Before | Clear open target | Selection still needed |
| --- | ---: | ---: | ---: |
| Model turns | 4 | 2 | 3 |
| Tool calls | 5 | 2 | 4 |
| Tool errors | 1 | 0 | 0 |
| Peak exposed tools | 21 | 21 | 21 |
| Peak SDK schema characters | 17,184 | 17,184 | 17,184 |
| Cumulative schema characters | 68,736 | 34,368 | 51,552 |
| Estimated cumulative input tokens | 48,292 / 46,914 | 24,345 | 35,302 |
| Sum of tool call durations, isolated sample | 15 / 4 ms | 12 ms | 5 ms |
| Original PDF reads | 1 | 2 | 2 |

The two before values correspond to the clear-target and explicit-selection
requests. Repeated updated runs measured 2 ms of tool time for both; these small
samples are noisy and do not establish a tool speed improvement. Final source
hash verification adds one original-file read, outside the tool-call timing.
Token counts use the existing character estimator, not provider billing.
The old code saves successfully after recovering `NO_ACTIVE_DOCUMENT`; it fails
only the new regression expectations for turn count, errors and verification.

The supplied live result (6 turns, 10 calls, 29 peak tools, 116.8K input tokens,
44.3 s total / 40.4 s model / 232 ms tools) is a separate observation, not the
baseline for these fixtures. No live model speed or cost improvement is claimed.

## Model and context findings

The local `.env` selects OpenRouter `deepseek/deepseek-v4-flash-0731`.
`createOpenRouterModel` applies low reasoning only to the exact slug
`deepseek/deepseek-v4.1-flash`, so it does not apply to that configured default.
User preferences can override the default; without the original trace this does
not establish the exact slug/provider route used by BluePeak. No reasoning,
provider or model default was changed. The supplied timing is dominated by model
execution; tool scheduling cannot explain or remove that inference time.

Context already refreshes the current DOCX view only after mutations and reuses
unchanged read observations. Attachment evidence stays bounded and extraction is
cached. Discovery and recovery still cost repeated full requests when they add
turns. The fixture removes those extra requests without shrinking each schema
catalog. Provider prompt-cache hits and live reasoning latency were not measured;
mocked usage is not evidence about either.

## Checks and closure

- API: 527 passed, 25 configuration skips; build and typecheck pass.
- Agent Core: 46 passed; build and typecheck pass. Coverage includes selection
  failure, read concurrency, ordered mutations, hidden-tool loading, provider
  wire messages, reasoning and Continue.
- Web: typecheck passes; 157 tests pass with the installed `tsx` loader. The
  default strip-types command retains its 21 known extensionless-import failures.
- Existing isolated PostgreSQL attachment integration passes: temporary schema,
  binding/access/cache, native editable-copy/save/reopen, source preservation,
  and storage accounting. The schema is removed by the test.
- Native API regressions cover BluePeak-style PDF → existing DOCX updates,
  cached original-byte changes, changed/deleted/unauthorized/unavailable sources,
  exact workspace draft/version/hash checks, same-task source changes across
  Continue, source page/visual references, image vision, PDF extraction, DOCX
  creation, and unrelated content preservation. No paid model calls were run.
- `git diff --check` passes. Unrelated web/status changes stay outside the commit.

C2's deterministic implementation gates pass. Final dogfood closure still needs
one browser run with the original BluePeak files and the configured live model,
checking target selection and the source-verification receipt. That is the
recommended next step before C3; it was not run here.
