# Phase 8 — DOCX acceptance and release readiness

**Verdict: CONDITIONAL. Phase 8 is not complete and publication is blocked.**
The supported local DOCX edits and macOS ARM64 packed consumer pass. Fresh Word
checks, Word save/reopen, Google Docs, and current cross-platform artifacts remain
unverified. General engine CI also has existing PPTX lint failures. No push,
publish, release tag, deployment, version bump, or consumer-pin change occurred.

## Acceptance gates

| Gate | Result | Evidence / remaining condition |
| --- | --- | --- |
| 1. Integrity | PASS for tested supported operations | 17 preservation outputs; native/API refusal and atomic-batch regressions; malformed unrelated XML now refuses output. No demonstrated supported-edit data loss remains. This is bounded syntax/package verification, not full OOXML schema certification. |
| 2. Interoperability | BLOCKED / unverified | Current Northstar input/output render to ten pages; all ten output pages reviewed. Word control denied in this session. Three Phase 7 Word opens are prior evidence only. Word save and Google Docs round trips were not performed. |
| 3. Agent correctness | PASS for tested workflows | 450 API and 41 Core tests pass, including Phase 1–7, precise edits, exact proposal values, mixed failures, source isolation, and Turn 21 replay. Two live DeepSeek tasks produce correct saved/unchanged documents. Persistence services in these runs are in memory; database-backed tests remain skipped. |
| 4. Release packaging | PASS on macOS ARM64; cross-platform distribution unverified | Current release binary packed through supported N-API commands, installed as a platform package in an isolated consumer, loaded without source/engine overrides. Full five-target assembly refuses missing current artifacts. |
| 5. Scope | PASS | Existing validators/runtime reused; four bounded defects fixed; no new operations, framework, dependency, product UI, or customer-document redesign. Unrelated web changes excluded. |

## Defects found and fixed

1. The OPC XML check accepted empty parts, multiple roots, duplicate attributes,
   undeclared element/attribute prefixes, text outside the root, and unknown
   entities. A normal text edit could then return success with malformed unrelated
   XML. The existing check now uses the installed namespace-aware XML reader,
   validates attributes/entities and a single root, and keeps well-formed unknown
   namespaces intact. The Rust regression failed before the fix; native tests
   assert refusal, absent output, and unchanged input bytes for four variants.
2. Repeated native **release** builds cleaned the debug adapter cache. Cached
   release code did not re-emit type records, causing declaration generation to
   fail with ENOENT. Cleaning the release adapter profile fixes this; two successive
   supported release builds regenerate all 62 exports and pass declaration checks.
3. `pack:dry-run` called `process.exit` on a child failure, bypassing its `finally`
   and potentially leaving injected optional dependencies in package.json. Throwing
   lets the existing restoration run. The regression failed before and passes after.
4. The installed N-API CLI defaults GitHub release creation to true. Metadata-only
   dry-run and CI root-metadata commands now explicitly pass `--no-gh-release` as
   well as `--skip-optional-publish`. No GitHub release was created during testing;
   the temporary environment had no GitHub repository setting.

## Save pipeline and truthful verification

Request → API target/version resolution → Agent Core tools → run-local engine host
→ source-local Rust mutation → native serialization/verification → one API save
→ exact saved-version verification → durable outcome. Only successful native output
replaces working bytes. Rust checks ZIP/XML/relationships, reopens, and verifies
operation-specific postconditions; content types use the existing OPC reader.

`docx-tools.flush` saves dirty bytes once. `documents/service.ts` writes a unique
storage object, records size/SHA-256, locks the document row, checks the base version,
and creates an immutable version in a transaction; it removes the new object on
transaction failure. `readExactVersionBytes` never substitutes latest. Stored
checksums are not recomputed on every read. Database/configuration tests remain
skipped; the configured remote database was not mutated for this acceptance run.

`execution.ts` verifies exact before/after IDs and blocks clean success for failed
recorded mutations, unavailable saved bytes and blocking validation failures.
Earlier valid edits can save on failure, cancellation or Continue: operations are
atomic, the whole run is not rolled back. Mixed-batch, version-conflict and
persistence-error regressions pass.

The existing verifier checks bounded structure, recognized review/field
postconditions, selected total rows, periods, placeholders and recorded recovery.
Its “open” check is semantic inspection, not a Word open or another complete
package validator. It cannot prove every requested edit was attempted or every
business statement reconciled. Anchor/XML preservation was compared separately;
field counts do not establish recalculation.

## Integrity and realistic documents

Reused ten small temporary Word-semantic fixtures plus the actual Northstar
proposal and the Word-authored engine template. The API proposal regression adds
three business tables and matching narrative; the 101-paragraph report regression
covers long-document styles and preserved direct italic emphasis. Existing tests
cover comments/revisions, fields/bookmarks/TOC, protected edits, and references.
No permanent document-fixture library was added.

The 17 current outputs pass ZIP CRC, XML parsing, package-membership, content-type
mapping and internal-relationship checks. Unrelated uncompressed part payloads are
byte-identical; compressed archive bytes are not promised identical. Only intended
main-document/style parts change. Review text/author/date/anchors, revisions,
field instructions/results, bookmarks, hyperlinks, styles, tables, numbering,
sections, headers and footers survive the supported source-local edits.
The actual Northstar refused paragraph deletion saves zero versions; a narrow
first-client-reference edit saves exactly one and preserves its Finance comment
and footer PAGE field. The original customer file remains untouched.

## Layout and editor coverage

The engine preserves or explicitly edits Word layout instructions: page sizes,
margins, section breaks, paragraph spacing/styles/keep controls, page breaks,
table grids/cell widths, and header/footer references. It does **not** calculate
rendered pagination, evaluate fields, or populate a TOC. The actual Northstar
contents list is static and remains labeled as such.

Northstar main XML equals the original with only the first requested client-name
substitution. Both bundled LibreOffice renders have ten pages; pages 2–10 are
pixel-identical, with only the requested title-page text changed. The input already
has risk-table widths 2200/1000/1000/2900/1900 twips, including the awkwardly wrapped
Likelihood header. This is an input layout limitation (A), not a mutation defect.
Word/LibreOffice font and spacing differences are renderer observations (C);
no current OOXML change explains them. Earlier extra-pagination exports lack a
matched input/output chain and remain unclassified; no causal fix is claimed.

| Editor | Open/render | Save and reopen | Relevant semantics |
| --- | --- | --- | --- |
| Microsoft Word | Three Phase 7 outputs opened without repair; fresh Phase 8 control denied | Unverified; Phase 7 license was view-only | Prior recognition of table/comment/TOC/revisions; no fresh certification |
| Google Docs | Browser reaches Google sign-in | Not performed; no signed-in test session | Unverified; no file uploaded |
| Bundled LibreOfficeDev 26.8 alpha | Current ten-page Northstar renders reviewed | Two outputs exported to DOCX, reopened in a fresh headless process and exported to PDF | Comment anchors/bodies/authors retained; main review categories retained; some semantics normalized as below |

LibreOffice round trip rewrites package/style XML, renumbers mixed revision IDs,
normalizes TOC-switch order and comment timestamp precision, and adds a second
Northstar footer PAGE field in another footer variant. Comments and recognized
review/field structures remain inspectable, but this is **limited compatibility**,
not byte/identity preservation or certification of all advanced markup. These
changes are external-editor behavior, not OpenSuite mutation defects. The renderer
is a bundled development build; stable desktop LibreOffice remains unverified.

Northstar still contains the editorial maintenance-cost discrepancy: $185,000 to
$155,000 implies 16.216%, while the Executive Summary says 12%. Existing verification
returns no warning for it: generic cross-narrative percentage reconciliation is
outside its bounded total/period checks. Both values remain unchanged. No financial
reasoning engine or special-case code was added. The narrow client edit deliberately
does not change all client references or claim that it did.

## Deterministic and live measurements

| Workflow | Main model turns | Tool calls | Native mutations | Saved versions | Runtime / provider cost |
| --- | ---: | ---: | ---: | ---: | --- |
| Scripted exact proposal revision | 5 | 5 | 4 | 1 | 101 ms locally; no provider calls |
| Scripted 101-paragraph native styles | 4 | 5 | 2 | 1 | 43,596 estimated input tokens; no billed/model latency claim |
| Scripted paragraph-by-paragraph comparison | 37 | 104 | 101 | 2 | 724,475 estimated input tokens; requires Continue |
| Scripted uninterrupted / Continue equivalence | 22 / 22 | Existing replay assertions pass | 3 / 3 | 1 / 2 | Final bytes equivalent; historical tools do not run twice |
| Live precise KPI edit | 2 | 1 | 1 | 1 | 2,997 ms; provider reports $0.00204064 |
| Live protected-comment request | 5 | 8 | 0 | 0 | 35,331 ms; provider reports $0.00694792 |

Live model: configured OpenRouter `deepseek/deepseek-v4-flash-0731`, production model
adapter, real Agent Core/API tools/native engine, synthetic documents, in-memory
version/transcript services. Main-loop provider usage was 14,024 input/276 output/
102 reasoning tokens for KPI, and 44,198/2,715/2,274 for refusal. KPI needed zero
discovery turns or extra inspections; refusal used two discovery turns, two
different initial inspection focuses, and one comment inspection. Repeated-read
suppression was zero; no redundant identical inspection was observed. KPI validation
passes; refusal explains the preserved anchor and leaves identical bytes.

The harness also launched two automatic title-model requests. Its title persistence
method was absent, so title saves failed; those requests' cost was not captured.
The table reports **main document loop cost/latency only**, not total experiment
billing or process duration. Initial sandbox DNS attempts failed with zero tools
and versions; the network-enabled checks above are the actual successful live runs.
No live Continue benchmark or deployed application/credit-billing smoke is claimed.

## Packed package and platform coverage

Supported CLI commands generated a host-only configuration in temporary storage:
`napi create-npm-dirs --config-path host-config.json`, `napi artifacts` with the same
configuration, and `napi prepublish --skip-optional-publish --no-gh-release`, followed
by `npm pack` for the root and darwin-arm64 package. No hand-made platform manifest
or consumer-side binary copy was used. A fresh consumer installed both tarballs
offline, using explicit platform dependency installation to avoid registry access.

The loaded binary is inside the installed `@opensuitehq/engine-darwin-arm64` package;
the installed root contains no direct native binary. Engine overrides are unset;
62 runtime exports exactly match packed declarations, which typecheck. Protocol
version remains 1; native/package version remains local 0.1.7. Creation, text/table
edits, comments, tracked replacement and unsafe deletion refusal all work.
Native SHA-256: `b633649f6f5c4a3094c3dd66e39275d9cbe0fb6b3585dd1903416d444b039749`.

Only macOS ARM64 / Node 22 was executed. macOS x64, Linux x64/ARM64 glibc, Windows
x64 MSVC, and the minimum Node 20 runtime remain unverified for these changes.
Old binaries from the 0.1.7 release were not counted as Phase 8 builds. Full assembly
and `pack:dry-run` correctly refuse the missing current platform artifacts.
The host-only package is not evidence that the final six-package registry
installation works. Existing CI defines the five builds, declaration/inventory
checks and six tarballs; obtain fresh artifacts before approving publication.

## Checks and release blockers

| Check | Result |
| --- | --- |
| Rust formatting / workspace compilation | PASS |
| Strict DOCX/OPC/protocol/Node Clippy | PASS |
| Rust DOCX / OPC / protocol / Node | 187 / 20 / 4 / 3 passed |
| Other existing Rust PPTX tests | 31 passed |
| Strict workspace Clippy | FAIL: existing PPTX type-complexity/manual-clamp/useless-format/format-collect warnings; unchanged by Phase 8 |
| Native release builds, generated declarations | Two repeated builds PASS; SDK and packed SDK typechecks PASS |
| Native Node suite | 37 passed |
| API / client / Agent Core | 450 / 39 / 41 passed; 23 API and 2 optional client skips |
| API/client/Core typechecks and API build | PASS |
| Local native bridge acceptance | PASS |
| Canonical release layout/version check (`--check`) | PASS at 0.1.7; local npm auth unavailable, CI uses OIDC |
| Packed host consumer | PASS |
| Full cross-platform assembly | BLOCKED by missing current artifacts |
| Phase 8 diff checks | PASS; unrelated existing web CSS whitespace issues remain untouched |

Release must wait for fresh Word representative open-without-repair checks and
an accurate save/reopen decision, current five-platform artifacts and six-package
checks, and resolution/explicit review of the existing general CI lint failure.
Complete database/storage and deployed application smoke in the intended test
environment; current memory-backed evidence does not certify those environments.
Unsupported complex revision decisions, modern comment replies/resolution,
field evaluation, full OOXML schema certification and pagination stay outside scope.

## Separate release checklist — plan only

1. Close the editor/environment and CI blockers above; record Word review and
   save/reopen results, and practical Google Docs limitations. Reuse the same
   representative artifacts and retain semantic comparisons.
2. Choose an unused patch version (candidate 0.1.8; confirm registry/tag availability
   separately). Run `scripts/release-engine.sh --check`; prepare with
   `scripts/release-engine.sh X.Y.Z --dry-run`. This later step aligns npm/Cargo,
   locks and generated loader. Do not reuse published 0.1.7 for these changes.
3. Write release notes covering Phase 1–8 safety/targeting changes, preserved
   protocol/API contracts, supported operations, explicit unsupported boundaries,
   and the repeated-build/packaging fixes. Commit the reviewed version changes.
4. Run ordinary CI and an explicitly dry-run native publishing workflow. Require
   fresh five-platform builds, inventory/SDK checks and all six tarballs. Install
   the root plus host platform tarball in clean consumers and test representative
   operations on each available target; validate current Linux Docker loads.
5. With separate release authorization, push the reviewed annotated version tag.
   CI publishes all five platform packages first, then the root with exact optional
   pins. Check registry contents and clean installs; never publish from this task.
6. Update the application consumer following `docs/engine_upgrade.md`: exact pin,
   lockfile including both Linux glibc binaries, release-age exclusions and current
   operational pins/docs. Test with `OPENSUITE_ENGINE_PATH` unset against the actual
   published package; build target Docker images and require native-load checks.
7. Run the live application document smoke, persistence/version-conflict checks and
   an editor round trip. Make a separate deployment decision only after these pass.
8. If loading/semantics fail, halt rollout and restore the previously tested app
   image/engine pin as a pair. Retain saved documents/version history. Publish a
   new corrected engine version if needed; never overwrite npm versions or silently
   replace customer documents. Review partially published platform packages before
   retrying the canonical release procedure.

## Evidence and commits

Temporary logs, scripts, preservation/layout/round-trip JSON, renders and tarballs
are under `/private/tmp/opensuite-phase8`; they are local evidence, not a fixture
library or customer-document replacement. Canonical retained regressions are in
the existing OPC/native tests and API execution test. Engine commit: `2cfbe085b3a706fcf2430f7f12f1280d57fa81de`. The application
commit hash is in the final delivery; this report cannot contain its own final hash.
