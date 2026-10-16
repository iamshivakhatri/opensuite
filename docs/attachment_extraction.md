# Chat attachment evidence

The API reads bound chat attachments as source evidence. They remain separate from
workspace documents and cannot supply mutation handles or select editing targets.
Cloud uses the same public application runtime; no Cloud-specific path is required.

`chat-attachments/extraction.ts` is the shared extraction entry point. TXT uses
strict UTF-8 decoding (optional BOM), normalized newlines, and 1-based line
locations. Markdown keeps source text, heading hierarchy, fenced code, and line
locations; HTML, links, and scripts are never executed or fetched.

The short-lived `docx-extraction-worker.ts` child process calls engine-client's
existing native reader. It preserves main-body order, headings, paragraph/list
facts, and table cell text. Locations use `paragraph:N` and
`table:N/row:N/column:N`. Tables retain row/column relationships in those locations;
large-source outlines include table dimensions and first-row labels. Native
handles are used only during extraction and are never persisted.

PDF uses Mozilla `pdfjs-dist@5.6.205` locally in the short-lived
`pdf-extraction-worker.ts` child process. Its API supports text streaming,
metadata, internal bookmark destinations, and page labels without rendering or a
viewer. The API requires Node 20.19+ on Node 20, or Node 22.13+. PDF.js is preferred
over a text-only wrapper because page warnings, labels and real bookmarks remain
available through one maintained parser. See the [upstream API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html).

A PDF extraction stores one unit per 1-based **physical** page (`page:1`), actual
extracted text, optional printed page label, dimensions, rotation and bounded line
positions/character offsets. Line positions use PDF user-space coordinates; page
rotation is separate. Text retains content-stream order, with geometric line
breaks/spaces. No headings, cells or row/column relationships are inferred. In
particular, content-stream column order can differ from visual reading order.
PDF.js may itself normalize whitespace or omit clipped/invisible text; this is a
text representation, not a visual completeness check.

The PDF structure contains metadata/XMP title or a marked filename fallback,
physical page count, processed page count, extraction completeness, bounded
Author/Subject/Creator/Producer/date/language/version metadata, real bookmarks and
resolved internal page destinations. External bookmark actions are not followed.
Titles/metadata fields are capped at 240 characters, bookmark titles at 160, page
labels at 80. At most 100 bookmarks and eight bookmark levels are represented;
`outlineComplete` and remaining counts distinguish omitted structure from none.
The PDF parser/policy version belongs to cache identity; fixed extraction limits
are stored in `pdf.options`. Bump `PDF_EXTRACTOR_VERSION` when changing that policy
or the pinned parser. TXT/Markdown/DOCX cache identities remain unchanged.

Pages distinguish `digital_text`, `limited_text`, `no_text`, and `failed`. Fewer
than 20 letters/digits or replacement characters conservatively flag limited
extraction. PDF.js recovery warnings are recorded as sanitized page/document
warnings, without logging their text; a damaged stream cannot silently become a
confident blank page. Image-only pages say that no extractable text does **not**
mean blank. Mixed pages can contain both digital text and unrepresented images.
Attachment ID + original hash + extraction ID + physical page number preserve the
source references needed for later rendering/vision. No OCR, image rendering,
provider-native PDF processing, secondary model request or external service is used.

Every representation retains the attachment ID, original SHA-256, extractor
version, and extraction ID. DOCX identity also includes the selected native engine
version and binary hash. The fixed reader policy belongs to `EXTRACTOR_VERSION`;
change that version when changing the policy. Successful JSON representations live
at an internally derived private object key beside the original. One cache object
per attachment replaces older extractor versions; no database table or persistent
worker is added. Concurrent requests for the same source share work. New model
turns, follow-ups, restarts, and Continue reuse the persisted representation.

`agent/attachment-evidence.ts` projects an attachment manifest immediately before
each provider request, including before the first tool call. Every current source
keeps its attachment ID, filename, format, original hash/size, and current/prior
label, including sources whose extraction fails or is unsupported. Extracted
sources also supply extraction identity, text size, title and title source,
heading hierarchy/section locations, table count/dimensions/first-row labels, and
how much body text was included. For DOCX/Markdown the first extracted heading supplies the display
title; otherwise the filename is explicitly marked as the fallback. No Word
core-properties title is inspected or invented. DOCX headings are main-body
headings, distinct from Word page headers and footers, which remain uninspected.

All ten possible current identities are reserved first. Up to five prior sources
are selected independently of that count. An authorized metadata query finds
filenames/IDs explicitly mentioned in the instruction regardless of age. Explicit
matches take priority; otherwise prior-source wording or lexical matches in cached
content select from the newest 50 bound sources. This does not inspect unrelated
original files. `historyMayBeIncomplete` flags bounded or omitted history; paged
`attachment.list` remains available for older sources outside the manifest.

Compact structure is reserved separately from body inclusion, so small files
retain useful headings/tables alongside complete text. Tiny extracted content
(up to 4,000 serialized bytes of locations/text and bounded page hints) is included completely when it
fits; larger sources provide bounded outlines and matching excerpts. Outlines
prefer relevant headings and report total/remaining heading and table counts.
PDFs add physical page counts, text-status counts, real bookmarks, literal page
text previews and page-aware excerpts to this same projection. Small PDFs include
all extracted text with physical page markers, without retrieval calls. Large
PDFs keep structure and selected excerpts; they do not inline every page. Repeated
PDF caveats are shortened if needed to preserve all current source identities and
page counts. Small TXT/DOCX/Markdown bodies are included before large-source
excerpts. `contentComplete` means included extracted text, never visual coverage;
`extractionStatus=partial` separately exposes parser limits/failures.
One 12,000-byte budget covers metadata, structure, and body evidence. Remaining
input room is calculated after the system, tools, instruction, and conversation
using existing estimates; attachment bytes use a more conservative one-byte-per-
token allowance. Older metadata and outline/body detail can be omitted explicitly.
If current identities cannot fit, the run fails with `ATTACHMENT_CONTEXT_LIMIT`
before the provider request instead of hiding a current source or trimming the
instruction. Full model-aware context management remains Part 10.

Use inline evidence immediately when sufficient. For an unknown fact/location,
load `attachment.search` directly with manifest IDs. For more detail at a known
section/location, load `attachment.read` directly and copy attachment ID,
extraction ID, and heading/table/line location; heading locations support
`section=true`. Do not list, search, read, or inspect to confirm supplied facts or
structure. `attachment.list` is only for older sources omitted from bounded
history. These instructions appear in the system policy, capability catalog, and
tool descriptions; no extra discovery or model call is added automatically.

The existing dynamic capability registry still owns list/search/read exposure.
Read accepts exact locations, table/row prefixes, heading sections, or bounded
indexed ranges. Long reads return continuation offsets, completeness, and
remaining-location counts. A copied extraction ID rejects stale references.
PDF uses these same dynamic tools. Search accepts one or multiple selected
attachments and returns page-aware lexical excerpts, extraction identities and
`nextOffset` for the same query/IDs. A source summary also warns that no lexical
match cannot rule out facts in unrepresented visual content. Read accepts
`location="page:3"`, optionally `pageEnd=5` for an inclusive physical page range,
and the existing location/text offsets for continuation. Printed labels are not
selectors. Partial extraction pages that were never processed return
`PDF_PAGE_UNAVAILABLE`, rather than an empty page. Responses retain source identity
and page warnings; bounded layout hints report omitted line counts. Searches or
reads that cannot fit even one result fail explicitly instead of returning a
continuation that cannot advance.

Every extraction, cache access, search, and read checks the current owner and
thread and requires a bound message attachment. Tools accept attachment IDs, never
object keys or paths. Delete and workspace purge remove cache objects; a concurrent
cache save rechecks authorization and removes its output if access was revoked.
Evidence is JSON-encoded, explicitly untrusted, and covered by system instructions
that deny source text authority over tools, permissions, or editing targets.
Ordinary logs do not receive full source bodies. Existing opt-in full run traces
can contain provider content, as documented in `agent_core.md`.

Bounds: 25 MiB original upload limit; 64 MiB declared ZIP expansion and 2,048 ZIP
entries; no encrypted, split, or ZIP64 archives; 20,000 extracted locations and
1,000,000 text/section characters; 4 MiB cache JSON. Native extraction has a
10-second kill deadline, a 128 MiB JavaScript heap limit, and at most two native
reader processes per API instance. The heap limit is not a native RSS limit.
Original/cache streams have read deadlines and byte limits. List/search/read
content shares an 8,000-character response budget; long units are paginated.
Malformed/unsupported inputs return structured errors without caching success.
PDF header and actual parser validation both run after byte/hash verification.
Encrypted PDFs, including files with an empty password, are refused. PDF parsing
uses the same two-reader concurrency limit, 10-second parent kill deadline and
128 MiB JavaScript heap bound. A sampled 384 MiB child RSS guard adds protection;
it is not a hard OS memory limit during synchronous/native allocation. Deployments
requiring a hard RSS ceiling must supply container/OS memory limits. Network fetch,
eval, WASM, system-font lookup and rendering are disabled; only bundled local font
and CMap resources are read. Document JavaScript, links, actions and embedded files
are never executed or opened.

PDF work is capped at 500 pages (larger files fail), 20,000 text items per page,
100,000 text items total, 1,000,000 text characters, 64 stored line hints per page,
and 3,500,000 content JSON bytes. Metadata/bookmark work shares the process
deadline/memory limits. Text/item/output limits return explicit partial results
when possible; process timeout/memory/crash returns a structured failure, not
successful extraction. At most eight relevant line hints accompany each inline
unit/excerpt/read slice. All long text remains available through bounded reads
until an explicit extraction limit. No file path/object key is exposed as a tool
argument.

DOCX text extraction covers the main body only. Headers, footers, notes, comments,
deleted revisions, text boxes, embedded objects, images, page layout, and merged or
nested table relationships are not represented. These limitations accompany the
source evidence. Unsupported body blocks are identified. Image/vision handling remains Part 6; no OCR, vectors, or LLM extraction is used.

Verification uses temporary native DOCX fixtures and captures the actual scripted
provider's prompt. Permanent checks cover direct tiny files, headings/lists/tables,
large-source budgets, lexical search, exact/paged reads, cache reuse, prior-source
selection, Continue, stale/deleted/unauthorized sources, malformed native input,
UTF-8 errors, and unchanged originals/targets. The isolated PostgreSQL test covers
real binding authorization and cache cleanup. A scripted provider creates a new
native document from a DOCX and a short note, saving both sources' facts in one
new version. Four large DOCX sources contain 149,228 extracted characters and
project 5,397 initial evidence bytes, up from Part 4's 4,752 (+645 bytes), with one
original read per source. Three small TXT/Markdown/native DOCX sources use 3,613
evidence bytes and zero tools. Ten current sources with large outlines and one
invalid encoding retain all identities in 11,644 bytes without tools. A named
prior source outside recent history appears alongside ten current sources without
listing. A targeted large-source task uses one exact capability load plus one
section read and one search across three provider requests, with zero attachment
lists or capability list/search calls. Continue, security, and saved native document
creation checks remain passing. No paid model calls were used.


C2 Part 5 verification: generated compressed PDF fixtures cover two digital pages,
real bookmarks/labels, an 80-page report, numeric evidence, mixed image/text pages,
limited text, a damaged page stream, encrypted/corrupt/header-spoofed files,
501-page rejection, partial character limits, page/range/text/search pagination,
ten current source identities, DOCX/TXT coexistence, cache reuse, Continue, and
staged/deleted/cross-user/cross-thread rejection. Actual scripted provider-bound
messages are inspected for small and large PDFs; no live model calls are used.
The isolated PostgreSQL check uses a real two-page PDF, verifies persisted reuse,
access rejection and deletion cleanup, then removes its test schema.

A separate temporary ReportLab business report with a drawn numeric table and an
image-only second page preserves $42,750.25, $19,125.00 and 18.5%, with correct page
references; a real pypdf password-encrypted copy returns `PDF_PASSWORD_REQUIRED`.
Representative local extraction is about 0.5 seconds for the 80-page/138,501-text-
character report; cache JSON is about 386 KB. The combined tiny PDF/DOCX/TXT run
uses 4,706 evidence bytes, zero tools and 8 ms on its cached follow-up.
Nine PDFs plus a small TXT retain all ten identities in 11,864 bytes. These are local,
scripted measurements, not provider latency or load-test claims.

Part 6 should render/interpret only the needed flagged physical pages, retain
these exact immutable source references, and distinguish visual evidence from
this text extraction. Complex columns, tables, charts, scans, handwriting, forms
and images remain limitations of this part.

Final checks: API 483 passed / 25 configuration skips; API/web typechecks, isolated
PostgreSQL attachment test, and `git diff --check` pass. No push or paid model calls.
