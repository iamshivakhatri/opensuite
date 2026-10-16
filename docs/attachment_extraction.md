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

`agent/attachment-evidence.ts` projects an attachment manifest immediately before
each provider request, including before the first tool call. Every current source
keeps its attachment ID, filename, format, original hash/size, and current/prior
label, including sources whose extraction fails or is unsupported. Extracted
sources also supply extraction identity, text size, title and title source,
heading hierarchy/section locations, table count/dimensions/first-row labels, and
how much body text was included. The first extracted heading supplies the display
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
(up to 4,000 serialized bytes of locations/text) is included completely when it
fits; larger sources provide bounded outlines and matching excerpts. Outlines
prefer relevant headings and report total/remaining heading and table counts.
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
The extraction representation, version, private cache, and native reader are
unchanged by Part 4.1.

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
project 5,397 initial evidence bytes, up from Part 4's 4,752 (+645 bytes), with one
original read per source. Three small TXT/Markdown/native DOCX sources use 3,613
evidence bytes and zero tools. Ten current sources with large outlines and one
invalid encoding retain all identities in 11,644 bytes without tools. A named
prior source outside recent history appears alongside ten current sources without
listing. A targeted large-source task uses one exact capability load plus one
section read and one search across three provider requests, with zero attachment
lists or capability list/search calls. Continue, security, and saved native document
creation checks remain passing. No paid model calls were used.
