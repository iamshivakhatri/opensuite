# C2 Part 7 — Attachment-to-DOCX workflows

C2 is ready for manual dogfooding. Deterministic tests exercise the real agent
loop, native DOCX tools, saved versions, verification and reopening with scripted
provider responses. They establish integration correctness, not live model
reasoning quality or visual accuracy.

## Changes

- Added lazy `workspace.copy_attachment`. Load its exact ID when the user
  explicitly requests an editable copy of an attached DOCX. It uses the existing
  document creation service, current workspace, active binding and lifecycle
  events. Original bytes are copied without reconstruction or attachment mutation.
  The source reader checks bound owner/thread/workspace, DOCX format, current
  extraction ID, native extraction readiness, byte length and SHA-256, then checks
  access again. Stale, staged, deleted, foreign and changed sources refuse.
- A saved new document now counts as preserved work when a task stops or fails
  before appending another version. Run reports classify that physical run as
  partial; failure messages disclose preserved changes. Creation does not inflate
  the appended-version count. Continue resumes the existing copy and loaded tool,
  preserving its source references without creating another document.
- Source guidance now explicitly distinguishes source facts, absent information,
  conflicting periods/versions/figures, visual uncertainty and workspace content.
  Material unresolved conflicts require a decision. Existing evidence budgets and
  retrieval/vision behavior are retained.

The copy tool stays outside the initial tool schemas, and is unavailable when the
attachment reader is not wired. No engine, provider configuration, Agent Core,
frontend, extraction framework or database schema changes were needed.

## Deterministic scenarios

Temporary native DOCX, PDF, text, Markdown and screenshot fixtures are generated
inside the existing tests; no business fixture files are committed.

| Scenario | Main turns / tools | Original reads | Appended versions | Peak evidence bytes |
| --- | ---: | ---: | ---: | ---: |
| TXT + DOCX → new report with heading | 3 / 3 | 2 | 1 | 2,183 |
| All five formats → new report | 3 / 3 | 5 | 1 | 5,977 |
| 80-page financial PDF + notes → existing report | 4 / 4 | 2 | 1 | 8,706 |
| Screenshot + selected scanned page → report section | 4 / 4 | 3 | 1 | 4,183 |
| Conflicting same-period figures → decision requested | 1 / 1 | 2 | 0 | 1,877 |
| Multiple sources → saved edit → Continue → finish | 4 / 4 total | 3 | 2 | 3,676 |
| DOCX → editable copy → edit, uninterrupted or Continue | 4 / 4 total | 2 | 1, plus new v1 | — |

All scenarios use zero attachment lists, capability lists/searches, workspace
searches, document inspections or document finds. Exact capability loads are
counted as tools. Native verification reads are separate from model-requested
inspection. The financial workflow uses one targeted attachment search and retains
physical page 67, its extraction identity and original hash. It verifies exact
revenue/cost/profit values, integer-cent arithmetic, the selected document, and
unchanged unrelated table, paragraph styling and image structure. The visual
scenario sends actual image parts to the scripted main provider and renders only
physical page 2. Its generated observations are explicitly qualified.

Continue tests reopen persisted native bytes in a fresh execution service and
extraction service. They retain the original instruction, source extraction IDs,
prior successful tool outcomes and loaded capabilities; completed replacements
and copy creation occur once. Existing tests additionally cover follow-up source
selection, stale handles/drafts/versions, partial mutation recovery, unsupported
vision, explicit visual-reader permissions, attributed reader observations and
cache reuse across Continue. Agent Core tests capture actual OpenRouter wire JSON
for image delivery and transcript ordering with mocked HTTP responses.

`ATTACHMENT_WORKFLOW` test diagnostics record turn/tool counts, evidence sizes,
original reads and versions. Serialized diagnostic request sizes include SDK
binary representations; they are not wire sizes or billable token estimates.
Focused scenarios take about 4.4 seconds locally; this excludes real provider
latency and is not a load-test result. No paid calls were made.

## Checks

- API: 505 passed, 25 configuration-dependent skips; build and typecheck pass.
- Focused workflow/security checks: 9 passed.
- Web: 148 passed using the installed `tsx` loader; typecheck passes. The default
  strip-types command's existing extensionless-import limitation remains.
- Agent Core: 42 passed; typecheck passes.
- Isolated PostgreSQL attachment check passes using a temporary schema and private
  in-memory object storage. It covers binding/auth/cache cleanup plus the real
  agent → editable copy → new saved version → native reopen path, original-byte
  preservation and storage accounting. The test removes its schema.
- `git diff --check` passes.

Tests are in `apps/api/src/agent/execution.isolation.test.ts`,
`apps/api/src/agent/agent-run-report.test.ts`, and
`apps/api/src/chat-attachments/service.test.ts` (DB test enabled with
`RUN_CHAT_ATTACHMENT_DB_TESTS=true`).

## Limits and next check

Mocked choices prove that evidence and tools reach the provider and that requested
operations save correctly. They do not prove a live model will notice every
conflict, use every source correctly, or interpret screenshots accurately. Native
verification checks document integrity and recorded work; it is not a universal
proof of factual grounding. PDF reading order/table relationships and unrepresented
DOCX parts retain the limits in [attachment extraction](attachment_extraction.md).

Browser pre-send uploads, later-message references, copy activation, Continue,
SSE, download/Word appearance and permitted live-model accuracy remain manual
checks. Linux production PDF rendering also remains unverified here. Next: run
those browser-to-Word attachment workflows before treating C2 as production-ready.

C3 retains broader historical retrieval work: bounded prior-source discovery is
not a complete historical evidence archive. C4 retains crash recovery and context
compaction; current Continue replay keeps its existing size limits and refuses
missing/legacy replay state. This phase does not redesign either area. No push,
deployment, provider changes or engine publication was performed.
