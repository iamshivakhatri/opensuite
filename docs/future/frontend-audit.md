All five audits are complete. Here is the consolidated professionalization report, synthesized from direct code inspection plus the five parallel audits: [sidebar/topbar/palette](b8f9fc68-368b-4f11-a7f7-911acd5d9d60), [tabs/header/shell](6d894f0c-1950-4db3-9c63-92fd8a3bda3a), [editor surfaces](97bfd931-6bff-443b-acbd-250219b285b9), [agent panel](cc64c283-9c05-4d67-904e-c1a5f49947c6), [settings/search/trash/a11y](307e1fbc-b32f-4047-8fd5-f8195e94a1d1).

No files were changed — this is analysis only.

---

## A. Current Frontend Architecture

**Stack:** Next.js 16 App Router + React 19 + Tailwind v4 (`@theme inline`) + `class-variance-authority`/`tailwind-merge`. No component library (no shadcn CLI, no Radix) — hand-rolled primitives styled shadcn-style.

**Composition, top to bottom:**

```
app/layout.tsx (ThemeProvider, ToastProvider)
 └─ app/app/layout.tsx (auth gate)
     └─ app/app/(shell)/layout.tsx → Sidebar + Topbar chrome
         ├─ (shell)/page.tsx           → WorkspacesHome
         ├─ (shell)/recent|starred/*   → DocumentLibraryView
         ├─ (shell)/write|slides|sheets → DocumentLibraryView (format-filtered)
         ├─ (shell)/trash/page.tsx     → TrashView
         ├─ (shell)/search/page.tsx    → SearchPageView
         └─ (shell)/settings/page.tsx  → SettingsView
     └─ app/app/workspaces/[id]/*  and app/app/documents/[id]/*
         └─ WorkspaceRouteShell → WorkspaceIde
             ├─ DocumentNavigationPanel (left, resizable, drag/drop upload)
             ├─ DocumentOpenTabs + DocumentHeader (center top)
             ├─ DocumentSurface → DocxSurface → DocxEditorHost → Casual Docs (center)
             └─ DocumentAgentPanel (right, resizable) — chat/agent UI
```

**Shared primitives (`components/ui/`):** `button.tsx`, `input.tsx`, `label.tsx`, `context-menu.tsx` (`ContextMenu`, `ConfirmDialog`, `PromptDialog`), `page-state.tsx` (`PageLoading`/`PageEmpty`/`PageError`). That's the *entire* primitive set for an app with ~10,400 lines of component code.

**Theming:** `lib/theme.tsx` + `theme-model.ts` own `data-opensuite-theme` on `<html>`; Casual Docs' own `data-theme` is deliberately kept separate and only synced one-way (`syncEmbeddedEditorColorTheme`). This is a clean, already-fixed boundary.

**Styling architecture:** CSS custom properties in `globals.css` (colors, 3-step radius scale, a `.opensuite-docx-host` → `--ce-*` token bridge for Casual Docs) exposed to Tailwind via `@theme inline`. Components consume them as `bg-surface`, `text-ink-soft`, `rounded-[var(--radius-sm)]`, etc.

**Icon system:** none — no icon library, no shared `Icon` component. Icons are inline emoji/glyphs/hand-drawn SVGs sized ad hoc per call site.

**Typography:** Inter via `--font-inter`; no defined type scale — sizes are one-off `text-[Npx]` literals per component (e.g. `text-[13.5px]`, `text-[10.5px]`, `text-[8.5px]`).

**State handling:** `lib/api.ts` (977 lines) centralizes fetch + `ApiError` parsing; `lib/toast.tsx` is a working lightweight toast system; `lib/agent-progress.ts` is a real reducer turning SSE events into human-readable progress lines.

---

## B. Biggest Professionalism Gaps (cross-audit synthesis)

Ranked by user-visible impact:

1. **Three parallel dialog/menu implementations.** `sidebar.tsx` (`Modal`, inline dropdown), `workspaces-home.tsx` (`Dialog`, inline dropdown), and `command-palette.tsx` (inline pickers) all reimplement what `components/ui/context-menu.tsx` (`ContextMenu`/`ConfirmDialog`/`PromptDialog`) already provides — with slightly different radii, shadows, and z-indexes each time.
2. **`document-agent-panel.tsx` is a 1,389-line monolith** mixing rendering, an SSE state machine, API orchestration, and markdown parsing, with hand-rolled buttons instead of `<Button>`.
3. **No confirmation UI actually wired up.** The agent panel detects `waiting_for_confirmation` and shows a passive text hint, but `ConfirmDialog` is never imported/rendered — there's no way to act on a confirmation from the UI as it stands.
4. **No in-panel "document updated" signal.** Version bumps refresh the editor silently in the background; nothing in the agent panel tells the user "updated to v7."
5. **Icon-only buttons systematically lack `aria-label`** (only 5 `aria-label` occurrences in the whole app) — sidebar "+", "···" menus, star toggles, header icon buttons all rely on `title` only.
6. **Border-radius and control-height drift.** `rounded-[8px]`, `[10px]`, `[16px]`, `[7px]`, `[9px]` etc. appear ~30+ times alongside the actual 3-value token scale; control heights span `h-7`–`h-11` for functionally equivalent icon/text buttons.
7. **Document tabs have no dirty indicator, no overflow menu, no reorder, no context menu, no Ctrl+Tab** — thin for a "document tab" model that's supposed to be the multi-doc backbone.
8. **Editor version-refresh remounts the whole surface** (`key=` change in `docx-surface.tsx`) — no cursor/scroll preservation, brief blank flash on every agent mutation.
9. **`docs/architecture.md` is stale** relative to actual implementation (still describes the sidebar as "a static visual placeholder"), which risks misleading future contributors.

---

## C. Design-System Foundation Audit

| Aspect | Status | Evidence |
|---|---|---|
| Color tokens (surface/paper/canvas/sunken/elevated) | **GOOD/KEEP** | `globals.css:6-34`, consistently consumed as `bg-surface`/`bg-canvas`/etc. |
| Semantic status colors (accent/success/danger + `-soft`/`-hover`/`-line`) | **GOOD/KEEP** | Used correctly almost everywhere (`text-danger`, `bg-danger-soft`) |
| Dark theme parity | **GOOD/KEEP** | Full parallel `:root` / `[data-opensuite-theme="dark"]` block, `--ce-page-paper` intentionally pinned white in dark mode |
| Typography scale | **MISSING** | No `text-xs/sm/base` scale — every component picks its own `text-[N.Npx]` (10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 18, 22…) |
| Spacing scale | **PARTIAL** | Mostly disciplined Tailwind spacing, but arbitrary `px-8 py-7`, `pt-[13vh]`, `w-[min(520px,...)]` appear in dialogs/overlays |
| Radius scale | **INCONSISTENT** | 3 tokens defined (6/8/12px) but ~30+ raw `rounded-[Npx]` literals bypass them (7,9,10,13,16,18px) |
| Control heights | **INCONSISTENT** | `Button` defines h-8/h-9, but icon buttons across the app use h-5, h-6, h-7, h-8, h-11 ad hoc |
| Icon sizing | **INCONSISTENT** | No shared icon component/scale; sizes range `h-2` to `h-[18px]` for conceptually similar icons |
| Focus rings | **PARTIAL** | Implemented well in `Input`/dialog inputs (`focus-visible:ring-2 ring-accent/20`); absent from most buttons, cards, star/menu toggles |
| Shadows/elevation | **INCONSISTENT** | No shadow scale — each dialog/menu hand-writes its own `shadow-[0_Npx_Mpx_rgba(...)]` with slightly different alpha values |
| Z-index | **MISSING** | No scale; raw `z-10/20/40/50/[60]/[70]/[80]` scattered with no documented ordering |
| Borders | **GOOD/KEEP** | `border-line` used consistently |

**Smallest fix that would matter:** add a `text-scale` (5–6 steps), a `z-index` scale, and a shadow/elevation scale as CSS variables next to the existing radius scale — then consolidate the 3 dialog implementations and the icon-button pattern into `components/ui`. That's it; the color/surface/radius foundation is already good and shouldn't be redone.

---

## D. App Shell / Information Architecture

- **Hierarchy is understandable once inside a workspace**: Sidebar → tabs → editor → agent panel maps cleanly to Workspace → Document → Conversation, and `DocumentHeader` shows workspace name + document + save state together (`document-header.tsx`).
- **Outside a workspace, hierarchy is weaker**: the sidebar's "Workspaces" nav item (routes to `/app`) and the "Workspaces" *list section* below it (individual workspaces) read as the same word doing two jobs — a genuine, if small, IA confusion (confirmed by [sidebar audit](b8f9fc68-368b-4f11-a7f7-911acd5d9d60)).
- **Editor is visually primary** inside a workspace — good flex-based layout gives it `flex-1`, panels are resizable and clamped (`ide-prefs.ts`), and Casual's own chrome is fully disabled (`chrome="embedded"`, no titlebar/menubar/statusbar) so there's no double toolbar.
- **Agent panel feels reasonably integrated** (same token system, same panel affordance as the file explorer) but is under-signaled at the finish line — runs complete silently from the document's point of view.
- **Unnecessary chrome:** minimal — no redundant global toolbar, no dashboard cruft. This is a genuine strength versus generic SaaS shells.
- **Panel sizing:** professional — persisted, clamped min/max widths (explorer 180–360px, agent 260–480px), pointer-capture drag handles. This is one of the more VS Code–like parts of the app already.

---

## E. Sidebar Audit

Real navigation surface, not just a route list — grouped sections (Navigate / Workspaces / Apps / Settings), consistent active/hover states using tokens (`bg-accent-soft`, `text-accent-hover`).

Gaps: workspace list has no collapse/expand/grouping (just scrolls past 240px); its "···" context menu and rename/delete `Modal` are locally reimplemented rather than using `ContextMenu`/`ConfirmDialog`; icon-only triggers (`+`, `···`) have `title` but no `aria-label`; no keyboard navigation within the workspace list itself (only the command palette has arrow-key nav).

---

## F. Tabs + Document Navigation

Tabs (`document-open-tabs.tsx`) get the fundamentals right: token-based active/inactive styling, hover-revealed close button, duplicate-open prevention, upload-drop feedback. They're missing everything that makes a *professional* multi-document workflow: no dirty/unsaved dot on the tab itself (only shown in the header), no overflow menu once tabs exceed the scroll area, no drag-to-reorder, no tab context menu ("Close Others"/"Close to the Right"), and no Ctrl+Tab/Ctrl+W-style tab-cycling (only single-tab close is wired in `workspace-ide.tsx`). Recommend adding these deliberately, not full IDE tab behavior — an overflow affordance and a dirty dot are the two with real user impact.

---

## G. Editor Experience

Strong foundation: the `--ce-*` token bridge (`globals.css:113-133`) means Casual Docs' chrome follows OpenSuite's theme with no visible seam, `chrome="embedded"` removes Casual's own titlebar/menubar/statusbar so there's a single toolbar layer, and conflict/version-mismatch banners are well designed (clear copy, doesn't block editing, explicit "reload" action).

Two real UX gaps: (1) version refresh **remounts** the editor via a changing `key=` prop (`docx-surface.tsx:436`) rather than loading the new buffer into the live instance — this drops cursor/scroll position and produces a visible flash on every agent-driven mutation, which will feel disruptive during active editing sessions; (2) there is **no visible save-state indicator surfaced from the editor itself** (only the header shows Saved/Saving/Conflict) and **no zoom control** is exposed by OpenSuite (Casual's own zoom, if any, is unmanaged by the host).

---

## H. Agent Panel / Chat UX

This is the most mature part of the app relative to its ambition. Default presentation is genuinely "quiet by default": live runs show a single collapsed one-line summary (Perplexity-style `AgentThoughtToggle`, `document-agent-panel.tsx:1282-1375`) with grouped/deduplicated tool steps behind an explicit expand toggle; no raw JSON/tool payloads are ever rendered; failures use `text-danger` consistently; cancellation has a real disabled-state/elapsed-time-aware Stop button; SSE reconnection with backoff exists.

Concrete gaps: **confirmation UI is not actually actionable** (text hint only, `ConfirmDialog` never wired in); **no manual retry button** after a failed run (user must retype); **no "document updated to vN" notice** in the panel itself; buttons are hand-rolled instead of reusing `<Button>`; the component's size (1,389 lines) mixes concerns that should be split into a run-subscription hook, a composer hook, and message-list/composer components.

---

## I. Agent + Editor Coordination Risks

- **Biggest confusion risk:** an agent mutation silently swaps the editor buffer (remount + flash) with zero in-panel acknowledgment — a user watching the chat has no correlated visual cue that "this text change is what just happened in the document," beyond happening to notice the canvas flicker.
- **Editing during a run:** dirty-suppression (`suppressDirtyRef`, 1200ms) and an explicit "Newer version available — reload to continue" banner correctly prevent silent data loss, but the messaging ("local edits will be discarded") is stern/technical for something that should read as reassuring in a product this deliberate.
- **Switching documents mid-run:** not explicitly audited at the code level in this pass — flagged as an open question worth a follow-up, since the agent panel and editor surface both key off `document.id`/`loadedVersionId` and a mid-run tab switch's interaction with `abandonLiveRun`/reconnect logic wasn't traced end-to-end.
- **Cancellation + partial success:** the run/version model appears to already treat "tool succeeded" as authoritative (per `docs/status.md`), which is the right backend contract; the gap is purely presentational — there's no UI treatment distinguishing "partially completed run" from "fully completed run" in the panel.

---

## J. State / Error / Loading Assessment

`components/ui/page-state.tsx` (`PageLoading`/`PageEmpty`/`PageError`) is well designed and **is** the dominant pattern across Workspaces, Library views, Trash, Search, Settings, Auth — genuinely good consistency there.

It breaks down specifically inside the IDE shell: `workspace-ide.tsx`'s "Opening file…" state, `workspace-route-shell.tsx`'s loading skeleton and error banner, and `document-navigation-panel.tsx`'s "Loading…"/empty-file states all reimplement bespoke versions of loading/empty/error instead of reusing the shared primitives. This is the single most fixable state-consistency gap: extend `page-state.tsx` (or add IDE-specific variants) and swap these call sites over.

---

## K. Accessibility + Keyboard Assessment

High-impact findings only:
- Icon-only interactive controls (workspace "+", "···" menus, star/unstar toggles, header back/star/trash buttons) rely on `title` (mouse-hover tooltip) rather than `aria-label` — screen readers get nothing for the most frequently clicked controls in the app.
- Focus-visible rings exist for text inputs (`Input`, dialog inputs) but not for buttons, cards, or icon toggles — keyboard-only users lose track of focus outside of forms.
- No modal focus trapping — Escape-to-close is implemented everywhere, but focus doesn't move into the dialog on open or return to the trigger on close.
- Keyboard shortcuts are limited to ⌘K (palette), ⌘O (upload), Cmd/Ctrl+S (save), Ctrl+W (close tab) and Enter/Shift+Enter in the composer — no tab-cycling, no list arrow-key nav outside the command palette.
- No `prefers-reduced-motion` handling found for the pulsing/animated indicators (agent "active" dot, drag overlay, textarea cursor blink).

---

## L. Component / Style Architecture Debt

- **Duplicated dialog chrome** in `sidebar.tsx`, `workspaces-home.tsx`, `command-palette.tsx` (3 near-identical overlay+card implementations) instead of one `components/ui/dialog.tsx`.
- **Duplicated context-menu chrome** in `sidebar.tsx` and `workspaces-home.tsx` instead of reusing `ContextMenu`.
- **`document-agent-panel.tsx` (1,389 lines)** is doing rendering + SSE state machine + API calls + markdown orchestration — the single largest cohesion problem in the codebase, by a 2.4x margin over the next-largest file (`api.ts`, 977 lines... itself reasonably organized as a flat API client, not a cohesion problem).
- **No shared `IconButton`** despite the same `h-7 w-7 grid place-items-center rounded-[8px]` pattern being hand-written 8+ times across `document-header.tsx`, `document-agent-panel.tsx`, `workspaces-home.tsx`.
- **No shared debounce hook** — `search-page-view.tsx` and `command-palette.tsx` both hand-roll `setTimeout`-based debounce.

---

## M. Performance Perception

- Editor version-refresh remount (`docx-surface.tsx:436`) is the one concrete, code-confirmed perceived-performance issue: full unmount/remount on every agent-driven save causes a visible flash rather than an in-place update.
- Agent panel scroll-to-bottom effect depends on `liveDraft?.content.length` (`document-agent-panel.tsx:596-601`), meaning it re-evaluates on every streamed token chunk, not just message boundaries — likely fine in practice given the `stickToBottom` guard, but is the kind of thing that can fight a user scrolling up mid-stream.
- Elsewhere, loading states are skeleton-based (`PageLoading` bone skeletons) rather than spinners in the well-covered surfaces (Workspaces/Library/Trash/Search/Settings) — correct choice for perceived performance; the IDE shell's ad hoc loading states are plain text ("Opening file…", "Loading…") with no skeleton, which will feel comparatively cheap.

---

## N. Light/Dark Theme Quality

Architecture is clean: single source of truth (`data-opensuite-theme`), one-way sync to Casual's `data-theme`, full dark-mode token parity, and an explicit decision to keep DOCX page paper white in dark mode for readability. The only bypass found is the brand gradient in `topbar.tsx` (`linear-gradient(145deg, #5E60E8, #8788F5)`) and the wordmark gradient — both hardcoded hex, unthemed, acceptable only if treated as fixed brand marks rather than surface color.

---

## O. Top 15 Prioritized Issues

| # | Issue | Area | User Impact | Arch Impact | Difficulty | Priority |
|---|---|---|---|---|---|---|
| 1 | Confirmation UI detected but not rendered (`ConfirmDialog` unused) | Agent panel | High — agent could be gated on confirmation with no way to respond | Low | Low | **P0** |
| 2 | No "document updated to vN" signal after agent run | Agent/editor coordination | High — silent state change erodes trust | Low | Medium | **P0** |
| 3 | Editor remounts (flash, lost cursor/scroll) on every agent-driven version change | Editor | High — disruptive during active review | Medium | Medium | **P1** |
| 4 | Icon-only controls lack `aria-label` app-wide | Accessibility | High for keyboard/SR users | Low | Low | **P1** |
| 5 | Three duplicated dialog implementations | Shell/component arch | Low visible, high maintenance risk | Medium | Medium | **P1** |
| 6 | `document-agent-panel.tsx` monolith (1,389 lines, mixed concerns) | Component arch | Low direct, high change-risk | High | High | **P1** |
| 7 | Duplicated context-menu implementations (sidebar, workspaces-home) | Component arch | Low visible | Medium | Low | **P1** |
| 8 | No manual retry after failed agent run | Agent panel | Medium — dead end on failure | Low | Low | **P1** |
| 9 | Border-radius drift (~30 one-off values vs 3-token scale) | Design system | Medium — subtle visual noise | Low | Low | **P1** |
| 10 | Control-height drift (h-5 through h-11 for similar controls) | Design system | Medium | Low | Low | **P1** |
| 11 | IDE-shell loading/error states bypass `page-state.tsx` | States | Medium — inconsistent "how things break" | Low | Low | **P2** |
| 12 | Document tabs missing dirty dot / overflow menu / reorder / context menu | Tabs | Medium for power users | Medium | Medium | **P2** |
| 13 | No z-index scale (raw 10/20/40/50/60/70/80 values) | Design system | Low visible, latent stacking bugs | Low | Low | **P2** |
| 14 | No shared `IconButton` / icon-sizing scale | Component arch | Low visible | Low | Low | **P2** |
| 15 | `docs/architecture.md` describes sidebar as "placeholder" (stale) | Docs | None to users, misleads contributors | Low | Low | **P3** |

---

## P. 10 OpenSuite Frontend Principles

1. Editor content stays visually and spatially primary; chrome (tabs, header, panels) never competes for attention or space with it.
2. Agent progress is quiet by default — one line, one status, expand for the timeline; never a raw tool/JSON dump, never chain-of-thought.
3. Every document mutation the agent makes surfaces a visible, dismissible acknowledgment in the panel that started it (version number, not silence).
4. One semantic token set (`--surface`/`--ink`/`--line`/`--accent`/etc.) owns every UI surface, border, and text color — no component hand-writes a hex or rgba value except deliberate brand marks.
5. There is exactly one implementation each of: dialog, context menu, icon button, confirmation flow. Every feature reuses them.
6. Every destructive action (delete, discard, trash) uses the same `ConfirmDialog` language and styling, no exceptions.
7. Radius, height, and icon size come from a fixed scale, not per-component judgment calls.
8. Every icon-only control has a real accessible name (`aria-label`), not just a `title` tooltip.
9. Keyboard and mouse are equally first-class: anything clickable in a list/menu/palette is also reachable and operable via keyboard.
10. State surfaces (loading/empty/error) are drawn from one shared vocabulary everywhere, including inside the IDE shell — not just on the marketing-adjacent pages.

---

## Q. Phased Roadmap (max 5 phases)

**Phase 1 — Design-token + primitive consolidation**
- Objective: close the token/consistency gap without touching layout.
- Files: `globals.css` (add type scale, z-index scale, shadow/elevation scale), `components/ui/button.tsx` (add `IconButton` size/variant), new `components/ui/dialog.tsx`, extend `context-menu.tsx` usage.
- Visibly improves: consistent radii/heights/icons across sidebar, header, agent panel, workspaces-home.
- Untouched: layout, IA, agent behavior.
- Regression risk: low — pure styling/prop refactor, if done incrementally file-by-file.
- Verify: visually diff sidebar/header/agent-panel buttons before/after; confirm no functional regressions in dialogs (Escape/outside-click still work).

**Phase 2 — Dialog/menu/state deduplication**
- Objective: replace the 3 dialog implementations and 2 inline context menus with the shared primitives from Phase 1; extend `page-state.tsx` usage into the IDE shell.
- Files: `sidebar.tsx`, `workspaces-home.tsx`, `command-palette.tsx`, `workspace-ide.tsx`, `workspace-route-shell.tsx`, `document-navigation-panel.tsx`.
- Visibly improves: identical dialog/menu feel everywhere; consistent loading/empty/error inside IDE.
- Untouched: agent panel internals, editor.
- Regression risk: medium — touches many interactive surfaces; test rename/delete/upload flows per surface.
- Verify: manually exercise every rename/delete/upload dialog and every context menu across sidebar/workspaces/tabs.

**Phase 3 — Agent panel decomposition + missing affordances**
- Objective: split `document-agent-panel.tsx` into hook(s) + components; wire `ConfirmDialog` to `waiting_for_confirmation`; add a "Document updated to vN" notice and a manual retry action.
- Files: `document-agent-panel.tsx`, `lib/agent-progress.ts` (if new event surfacing needed), `components/ui/context-menu.tsx`.
- Visibly improves: confirmation flows work end-to-end; users see version updates; failed runs are recoverable in one click.
- Untouched: run/version backend contract, engine integration.
- Regression risk: medium-high — this is the most complex file in the app; needs careful behavioral parity testing (SSE reconnect, cancel, scroll).
- Verify: run a full agent turn incl. a forced confirmation and a forced failure; confirm scroll/cancel/retry all behave identically to before.

**Phase 4 — Editor/document workflow polish**
- Objective: reduce remount-flash on version refresh (load into live instance or preserve scroll/cursor around remount); add tab dirty-dot and overflow handling.
- Files: `docx-surface.tsx`, `docx-editor-host.tsx`, `document-open-tabs.tsx`.
- Visibly improves: smoother agent-triggered updates; clearer multi-document workflow.
- Untouched: engine/version model, Casual Docs internals.
- Regression risk: medium — editor remount logic is deliberately defensive (conflict handling); any change must preserve the existing conflict/dirty-suppression guarantees.
- Verify: trigger rapid agent mutations while scrolled mid-document; confirm no data loss on conflicting concurrent edits.

**Phase 5 — Accessibility + remaining state/polish sweep**
- Objective: `aria-label` pass on icon-only controls, focus-visible on buttons/cards, focus trapping in dialogs, keyboard nav in sidebar/tab lists.
- Files: broad but mechanical — sidebar, header, tabs, library views, agent panel buttons.
- Visibly improves: screen-reader and keyboard-only usability.
- Untouched: visual design.
- Regression risk: low.
- Verify: tab through the full app shell with a keyboard only; spot-check with a screen reader on the 10 highest-traffic icon buttons.

---

## R. FIRST Implementation Milestone (recommendation only — not implemented)

**Add a small `components/ui` extension pass:** a `radius`/`z-index`/type-scale addition to `globals.css`, plus an `IconButton` variant on the existing `button.tsx`, plus one shared `components/ui/dialog.tsx` built from the existing `Modal`/`Dialog` patterns already duplicated three times.

Why this one: it's the smallest change that (a) is immediately visible (every icon button and dialog in the app becomes visually identical), (b) requires no behavioral/state-machine changes so regression risk is near zero, and (c) directly unblocks Phase 2's deduplication and Phase 3's confirmation-dialog wiring, which both need these primitives to exist first.

---

## S. Files/Components Likely Involved (across the roadmap)

`apps/web/src/app/globals.css` · `components/ui/button.tsx`, `input.tsx`, `context-menu.tsx`, `page-state.tsx` (+ new `dialog.tsx`) · `components/shell/sidebar.tsx`, `topbar.tsx`, `command-palette.tsx` · `components/workspaces/workspaces-home.tsx` · `components/documents/document-agent-panel.tsx`, `document-open-tabs.tsx`, `document-header.tsx`, `workspace-ide.tsx`, `workspace-route-shell.tsx`, `document-navigation-panel.tsx` · `components/documents/surfaces/docx-surface.tsx`, `docx-editor-host.tsx` · `lib/agent-progress.ts`, `lib/ide-prefs.ts`.