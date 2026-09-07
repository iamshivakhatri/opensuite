# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell + Trash + rename/restore lifecycle.
* Global metadata search + Cmd/Ctrl+K palette.
* Desktop UX polish: DnD upload, tabs, resizable panels, toasts, shortcuts.
* Persistent workspace IDE layout (no full remount on file/tab switch).
* Immutable document version foundation + Casual Docs DOCX surface v1.
* Theme architecture (`themePreference` / `resolvedTheme` / Casual isolation).
* **Production DOCX agent runtime is engine-backed (no mock DOCX content).**
* **Real DOCX inspect + paragraph/table mutations** (capability-gated), blank DOCX create, workspace agent chat.
* **Agent-loop efficiency v1:** model-facing projection, 90s turn timeout, `tool_choice: required` until create **or** first write, post-create authoring catalog narrowed (+ `set_paragraph_style`), one authoring-timeout retry, stream abort → fail (not empty complete).
* **New-doc structure defaults:** title → Heading 1; section labels → Heading 2.
* **Progress UI:** expanded timeline keeps **Thought** segments between tools (not only tool names).

## Just Completed

* Greenfield fashion prompt works (`e7989bc4`). Heading styles applied on follow-up (`e2d46fd9` v6–10) then run **failed** because create-force/nudge stayed on after edits — **fixed**: stop forcing create once any document write succeeds. Thought cadence preserved in progress timeline.

## Current Decisions

* Soft-delete only; latest = max `version_number`.
* Optimistic concurrency: `baseVersionId` + row lock.
* Rust is capability / affordance / semantic-mutation / diagnostic source of truth; app owns versions + handle lifetime.
* `pnpm dev:api` rebuilds agent-core first — restart after agent-core / engine-client / native binary changes.
* Local `@opensuite/engine` is `link:` to sibling `opensuite-engine`.
* Model-facing tool results may be slimmer than persisted/UI results.

## Known Gaps / Next Work

* Greenfield still flaky on slow DeepSeek authoring turns (timeout + one retry mitigates).
* Chat confirmations still verbose / emoji-prone.
* No model “chain-of-thought” tokens in UI — only step cadence (**Thought** + tool labels). True reasoning traces not exposed by current OpenRouter setup.
* Table/list/image polish deferred (see Intentionally Deferred).

## Verification Status

| Check | Status |
|---|---|
| `pnpm --filter @opensuite/agent-core test` | **Pass** (150) |
| `pnpm --filter @opensuite/api test` | **Pass** (95+17 skip) |
| `pnpm --filter @opensuite/web test` | **Pass** (progress Thought) |
| Live greenfield smoke / UI | **Pass** create path; edit-style follow-up fix pending restart |

## Intentionally Deferred

* Affordance-driven recovery; engine tool manifest
* Table themes / shading / merged cells / column sizing
* Lists / images / hyperlinks; full paragraph-formatting N-API
* PPTX/XLSX; HTTP mutation endpoint
* AgentRunner redesign / planner / DAG

## Recommended Next Step

Restart `pnpm dev:api` + refresh web; re-try “style the headline” on the open plan doc — should complete without the create-nudge failure; expand › to see Thought between steps.
