# DOCX round-trip notes (Casual Docs v1)

Manual fidelity checklist for OpenSuite ↔ Casual Docs. Do not claim more than verified.

## Workflow

1. Upload a real `.docx` in the workspace.
2. Open it — bytes load via `fetchDocumentVersionContent(documentId, latestVersion.id)`.
3. **Test A (no-op):** Save without editing → new version; reopen and compare.
4. **Test B (edit):** Change one sentence → Save (⌘S) → refresh/reopen.
5. Confirm prior version still downloads unchanged via version content API / Download after switching... (latest Download returns newest; use version content endpoint or DB for v1).

## Conflict

1. Two browser contexts on the same base version.
2. Save in A → vN+1.
3. Save in B → conflict banner; local edits preserved; Reload latest requires confirm if dirty.

## Verified in this milestone

* Package: `@casualoffice/docs` `DocxEditor` (host-owned `documentBuffer` / `export()`).
* Explicit save only (no Casual autosave / FileSource / collab / AI).
* Dirty via `onDirtyChange`; conflict via `409 VERSION_CONFLICT`.

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
