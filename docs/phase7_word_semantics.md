# Phase 7 Word semantics and interoperability

## Result and scope

The local engine and API now refuse the demonstrated unsafe Word-semantic edits
while preserving supported ordinary operations. Existing revision, comment, and
field capabilities were inspected before implementation. No new operation IDs,
frameworks, database changes, dependency pins, native publication, push, Cloud
changes, or model calls were needed. The published engine remains 0.1.7; these
fixes require the local native build until a separately authorized release.

The engine's `docs/word-semantics.md` contains the operation coverage map and
supported/unsupported boundaries. Standard comments already support add/update/
delete; revision authoring and individual accept/reject already exist; typed
PAGE/NUMPAGES and TOC insertion already exist. Resolve/replies, full move or
structural revision decisions, and field evaluation are not new capabilities.

## Defects fixed

| Defect | Result |
| --- | --- |
| Replacement joined ordinary text across hidden deleted content or range markers | Explicit `UNSUPPORTED_OPERATION` / `UNSAFE_TEXT_BOUNDARY`; no output bytes or version advance. Nearby ordinary edits remain supported. |
| Paragraph deletion saw only local markup | Existing protected-range checks now detect enclosing comments, bookmarks, multi-paragraph fields, and tracked properties. Body insertion uses the same boundary checks. |
| Ordinary revision decision inside a move/bookmark/field/conflict range | Refused rather than interpreting the selected revision independently. |
| Unsupported revision ends/table property exceptions/Word 2010 conflicts invisible | Counted and named through additive `revisionType`; old clients/engines remain compatible. |
| Formatting/comment/header-footer edits could duplicate or remove pending property history | Unsafe edits refuse; unrelated property and part bytes remain intact. |
| Instructions outside a complex field's instruction region went undiagnosed | `UNEXPECTED_FIELD_INSTRUCTION`, alongside existing malformed-marker diagnostics. |
| Optional external field refresh relied on counts | Refresh now refuses comments, pending revisions, unknown/malformed fields, and inspection failures/unavailability. Field inspection also flags revisions in header/footer parts. It keeps native bytes and reports the reason. Equal counts cannot establish anchor, body, or revision-XML preservation. |

The replacement, paragraph-deletion, header/footer-clear, and external-refresh
regressions failed against the earlier code before their fixes. No verification
rule was weakened to make a test pass.

## Changed files and ownership

In `opensuite-engine`:

- `tracked_change.rs`: complete recognized category detection and source element
  names; `field.rs`: misplaced instruction diagnostics; `field_inspection.rs`: pending
  main/header/footer revision warnings for the external-refresh guard.
- `mutation/text.rs`: reject hidden boundaries before text redistribution.
- `mutation/paragraph.rs`, `mutation/common.rs`, `mutation/protected_range.rs`:
  reuse existing guards for deletion, insertion points, and conflict ranges.
- `mutation/tracked_change.rs`: protect enclosing structures during decisions.
- `mutation/formatting/text.rs`, `mutation/comments.rs`,
  `mutation/header_footer.rs`: refuse destructive property-history combinations.
- Domain tests cover nine new high-value regressions.
- `opensuite-node/src/revisions.rs` and generated `index.d.ts` /
  `operation-inputs.json`: accurate existing operation descriptions. No export or
  protocol inventory changes.
- `docs/status.md`, `docs/docx-engine.md`, `docs/word-semantics.md`: current coverage
  and explicit limitations.

In `opensuite`:

- `packages/engine-client/src/docx-revisions.ts`: optional `revisionType`, passed
  through existing native JSON decoding.
- `apps/api/src/agent/field-refresh.ts` and its test: refuse external rewrites when
  comment/revision preservation cannot be proven from the existing inspections.
  This also makes the mixed-markup save test independent of LibreOffice presence.
- `apps/api/src/agent/word-semantics.test.ts`: real local native binding through
  lazy API tools, safe refusals, working revisions, and the one-save boundary.
- This report, `docs/status.md`, and `docs/engine_integration.md`: local build and
  consumer behavior.

The user's existing web UI edits were left untouched and excluded from commits.

## Interoperability matrix

Ten generated, temporary DOCX files used ordinary Word namespace markup and
valid OPC relationships/content types. Native inspection and source-local edits
ran through the built N-API binding.

| Fixture | Revisions total / unsupported | Comments | Fields | Outcome |
| --- | ---: | ---: | ---: | --- |
| Ordinary insertion/deletion | 2 / 0 | 0 | 0 | Four accept/reject combinations correct; other record retained. |
| Tracked move | 6 / 6 | 0 | 0 | Both content wrappers and four range markers surfaced; decisions refused. |
| Property/row/cell changes | 5 / 5 | 0 | 0 | Detected and preserved; decisions refused. |
| Formatted comment anchor | 0 / 0 | 1 | 0 | Nearby edit preserves comment body/metadata/range/reference. |
| Table comment | 0 / 0 | 1 | 0 | Whole anchored-cell edit refused; unrelated simple cell succeeds. |
| Simple fields | 0 / 0 | 0 | 7 | PAGE/NUMPAGES/DATE/REF/PAGEREF/HYPERLINK/unknown instructions and results preserved. |
| Complex fields | 0 / 0 | 0 | 6 | Begin/separate/end and cached results preserved. |
| Multi-paragraph TOC | 0 / 0 | 0 | 1 | Existing TOC/links/bookmark retained; deletion/insertion inside refused. |
| Hyperlink/bookmark | 0 / 0 | 0 | 0 | Nearby ordinary text edited without changing references. |
| Mixed Northstar-style proposal | 10 / 8 | 1 | 3 | Ordinary text/style edits preserve all unrelated advanced structures. |

Totals count XML records/markers, not logical move/edit groups. Synthetic fixture
text/style edits, the table-cell edit, a real Word-authored template edit, and the
actual Northstar API edit produced 17 outputs. ZIP CRC, XML parsing, internal
relationship targets, identical package membership, and byte-identical unrelated
part payloads passed. Ordinary fixture XML equals the input with only the planned
text substitution. Comment anchors and field/revision snapshots were checked in
addition to visible text. Temporary scripts/results are under
`/private/tmp/opensuite-phase7` and `/private/tmp/phase7-*`; they are test evidence,
not product fixtures or user document changes.

Actual Microsoft Word open checks passed without repair for three outputs:
the corrected mixed fixture, the Word-authored `opensuite-engine/test.docx`
output, and the latest Northstar API output. Word recognized the mixed TOC,
tracked content, table, and comment. Its field-update prompt was declined.
An initial synthetic fixture used deletion text inside a move source; changing
that fixture to ordinary `w:t` as specified by Microsoft removed its repair
prompt. This was a fixture defect, not evidence of engine serialization loss.

Word's installed license permits viewing but blocks edit/save. No Word save round
trip or Google Docs reopen is claimed. The bundled LibreOffice renderer produced
and reviewed all ten Northstar pages; font/page-spacing differences from Word
and a narrow risk-header column remain layout/interoperability observations.
The test windows were closed and Word was returned to the original proposal.

## Latest Northstar review

Reviewed `Northstar_Project_Lighthouse_Proposal_v1 (10).docx` from Downloads and
its supplied screenshot. The original remains unchanged.

- Zero pending main-document revisions is expected after the user's acceptance.
- One standard Finance Team comment remains, attached to the complete sentence
  about validating KPI assumptions during discovery. Identity, author/date, body,
  start/end anchors, reference, relationship, and content type are valid.
- One complex footer PAGE field remains. It repeats visually on ten Word pages;
  it is one stored field, not ten XML records. Rust does not calculate its value.
- Contents is explicitly a static list, with no TOC field or automatic page
  numbers. This is accurately labeled in the document.
- The five commercial items sum to $278,500. November 16, 2026 to March 8, 2027 is
  exactly 16 weeks. Scope consistently states 12 lines and 48 machines.
- The downtime target is consistent with approximately 24% improvement. The
  maintenance-cost table ($185,000 to $155,000 per quarter) implies about 16.2%,
  while the executive summary states 12%; this needs an editorial decision.
- The existing finance approval comment is still actionable before sending the
  proposal. No approval, commercial, date, or content changes were made.

A temporary API session first refused deletion of the commented paragraph and
saved zero versions. A separate supported client-name edit saved exactly one
version, retained the Finance comment/anchors and footer field, and retained the
expected zero revision count. Word reopened that copy without repair. The
committed synthetic Northstar API regression combines comments, pending ordinary
revisions, TOC and PAGE/NUMPAGES, checks failed-edit bytes/revisions, performs safe
text/style edits, and saves exactly once.

## Local checks

| Check | Result |
| --- | --- |
| Rust DOCX / OPC / protocol / Node crate | 187 / 19 / 4 / 3 passed |
| Rust formatting, strict scoped Clippy | Passed |
| Native debug build and Node tests | Built locally; 35 passed |
| Generated SDK declarations | Typecheck passed |
| Engine-client tests/typecheck/build | 39 passed, 2 optional skips; passed |
| API tests/typecheck/build | 449 passed, 23 configuration/DB skips; passed |
| Agent Core tests/typecheck | 41 passed; passed |
| Phase 1–6 regressions | Existing activation, recovery outcomes, handles, capability discovery, context/repeated reads, and Continue replay/efficient mutations passed in the full API/Core suites |
| Diff checks | Phase 7 files pass. The pre-existing web CSS diff has CRLF whitespace warnings and was not changed. |

Native tests used `OPENSUITE_ENGINE_PATH` pointing to the locally built sibling
checkout. Published dependency files and version pins were not modified.

## Remaining boundaries

Full move/structural/conflict decisions, modern comment replies/resolution,
unknown Word extensions, other-story revision inspection, full field evaluation,
TOC refresh guarantees, and layout/pagination remain deferred. Supported safe
edits and explicit refusals satisfy this phase's bounded semantic contract;
this is not full Microsoft Word compatibility. External refresh remains an
optional best-effort path for documents without comments, pending main/header/footer revisions, or
unknown/malformed fields;
other-story/unknown-extension preservation by external editors is not certified.
Further Word/Google save and producer/schema checks belong in later validation.

Commits are separate in the engine and application repositories; no push or
publication is part of this work.
