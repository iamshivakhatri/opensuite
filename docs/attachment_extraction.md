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

Every representation retains the attachment ID, original SHA-256, extractor
version, and extraction ID. DOCX identity also includes the selected native engine
version and binary hash. The fixed reader policy belongs to `EXTRACTOR_VERSION`;
change that version when changing the policy. Successful JSON representations live
at an internally derived private object key beside the original. One cache object
per attachment replaces older extractor versions; no database table or persistent
worker is added. Concurrent requests for the same source share work. New model
turns, follow-ups, restarts, and Continue reuse the persisted representation.

`agent/attachment-evidence.ts` projects evidence immediately before each provider
request. Newly submitted attachments have priority. Previous sources are selected
by filename, explicit prior-source wording, or lexical matches in cached content
among the newest 50 bound attachments. Older sources remain accessible through
paged discovery. Unrelated prior source bodies are omitted. Compact manifests are
reserved first, then complete tiny representations (up to 4,000 serialized bytes),
then bounded outlines and matching excerpts. One 12,000-byte budget covers all
sources. Remaining input room is calculated after the system, tools, instruction,
and current conversation using existing context estimates; attachment bytes use a
more conservative one-byte-per-token allowance. No instruction or active tool
exchange is shortened to make room. Full model-aware context management is still
Part 10.

The existing capability registry exposes `attachment.list`, `attachment.search`,
and `attachment.read` as dynamic tools. Load their exact IDs through
`capabilities.load`; the `attachment` domain is discoverable through list/search.
Listing pages cached readiness and compact structure; lexical search ranks exact
phrases and keyword matches. Read accepts exact locations, table/row prefixes,
heading sections, or bounded indexed ranges. Long text and multi-location reads
return continuation offsets, completeness, and remaining-location counts. A copied
extraction ID rejects stale references.

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

DOCX text extraction covers the main body only. Headers, footers, notes, comments,
deleted revisions, text boxes, embedded objects, images, page layout, and merged or
nested table relationships are not represented. These limitations accompany the
source evidence. Unsupported body blocks are identified. PDF text extraction and
image/vision handling remain Parts 5–6; no OCR, vectors, or LLM extraction is used.

Verification uses temporary native DOCX fixtures and captures the actual scripted
provider's prompt. Permanent checks cover direct tiny files, headings/lists/tables,
large-source budgets, lexical search, exact/paged reads, cache reuse, prior-source
selection, Continue, stale/deleted/unauthorized sources, malformed native input,
UTF-8 errors, and unchanged originals/targets. The isolated PostgreSQL test covers
real binding authorization and cache cleanup. A scripted provider creates a new
native document from a DOCX and a short note, saving both sources' facts in one
new version. Four large DOCX sources contain 149,228 extracted characters and
project 4,752 evidence bytes with one original read per source. No paid model
calls were used.
