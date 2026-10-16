# DOCX round-trip notes (Casual Docs v1)

Manual fidelity checklist for OpenSuite ↔ Casual Docs. Do not claim more than verified.

## Workflow

1. Upload a real `.docx` in the workspace.
2. Open it — bytes load via `fetchDocumentVersionContent(documentId, latestVersion.id)`.
3. **Test A (no-op):** Open without editing → no new version; refresh and compare.
4. **Test B (edit):** Paste or change a sentence → wait for Saved → refresh/reopen; version history must stay unchanged. Press Save (⌘S) → exactly one new version. Repeat with edits during an upload and an agent request immediately after pasting.
5. Confirm prior version still downloads unchanged via version content API / Download after switching... (latest Download returns newest; use version content endpoint or DB for v1).

## Conflict

1. Two browser contexts on the same base version.
2. Save in A → vN+1.
3. Save in B → conflict banner; local edits preserved; Reload latest requires confirm if dirty.

## Verified in this milestone

* Package: `@casualoffice/docs` `DocxEditor` (host-owned `documentBuffer` / `export()`).
* OpenSuite replaces one server draft after a one-second editing pause and before agent submission. Autosave never adds a document version. Explicit Save / ⌘S creates a version from the current content and clears that draft. Automatic saves pause during agent runs; failed automatic uploads retry after another edit or explicit Save.
* Each content change keeps its own edit count; edits during an upload remain dirty. A draft save updates its draft token without re-importing the editor; only manual Save advances the user version. Casual's local dirty/clean transitions do not confirm a server save.
* Conflicts still use `409 VERSION_CONFLICT`; history remains read-only. Automated save-state, engine, and isolated PostgreSQL lifecycle tests pass; the browser checklist above remains manual.

## Not verified here (manual / external)

* Microsoft Word open of exported bytes
* Google Docs import
* Exhaustive OOXML: headers/footers, fields, content controls, complex tables/images

## Known Casual limitations (upstream)

* Some OOXML constructs may be dropped or approximated on round-trip (Casual publishes a round-trip audit for their engine).
* Embedded chrome still includes Casual formatting toolbar (intentional for editing).
* AI, collab, and Casual persistence are disabled in OpenSuite.
* `@schnsrw/core` WASM: Turbopack needs `apps/web/vendor/s1engine_wasm_bg.wasm` (synced by `postinstall`/`predev`/`prebuild`) plus relative `turbopack.resolveAlias` — absolute aliases fail under Turbopack.
* Theme: OpenSuite uses `data-opensuite-theme`; Casual mutates `data-theme` — never share those. Host syncs Casual to `resolvedTheme` (not OS `auto`).

Re-run this checklist after any Casual Docs major bump.

Server draft storage requires migration `0026_document_drafts`. Exact version downloads remain immutable; normal downloads and agent reads include the current draft. Agent edits retain the existing one-version-per-run behavior.
