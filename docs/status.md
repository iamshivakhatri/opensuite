# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation (exact content GET, append, human save, `baseVersionId` concurrency, agent run provenance).
* **Casual Docs DOCX surface v1** (host-owned load/save; see `docs/docx_roundtrip.md`).
* **Theme architecture:**
  * `themePreference` (`light|dark|system`) persisted in `opensuite.theme`
  * `resolvedTheme` (`light|dark`) applied only via `data-opensuite-theme` on `<html>`
  * Casual Docs consumes theme: forced `casual-editor:color-theme` + mirrored `data-theme` (never `auto`)
  * DOCX page stays white paper; shell/chrome follow OpenSuite tokens

## Just Completed

* Theme source-of-truth + Casual Docs isolation (stop DOCX open from flipping app to dark).
* Semantic token polish for dark mode across shell, agent, dialogs, palette.

## Current Decisions

* Soft-delete only; panel prefs browser-local.
* Latest = max `version_number`; versions immutable.
* Optimistic concurrency: `baseVersionId` + row lock + unique version number.
* OpenSuite owns persistence + theme; Casual is render/edit/export only.
* Do **not** share `data-theme` with OpenSuite tokens — Casual mutates that attribute.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `pnpm build` | **Pass** |

## Intentionally Deferred

* Casual Sheets/Slides, autosave, agent selection context, agent artifact persistence
* Diff/review/revert, merge/rebase, version-history UI, collaboration
* Content search, permanent delete, Rust engine mutation
* Pixel-perfect Casual toolbar restyle (uses Casual vars; host passes resolved theme)

## Known Theme Limitations

* Casual still writes `data-app="docs"` / `data-theme` on `<html>`; OpenSuite ignores those for its tokens.
* Theme switch while DOCX is open updates Casual via DOM/`localStorage` without remounting (dirty state preserved).

## Recommended Next Step

Manual theme QA checklist (Light/Dark/System + DOCX open), then Casual Sheets when ready.
