# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v5.3** + **AgentCore v2 Steps 1–5C**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1** — semantic activity groups, compact live progress, collapsed completion, expandable technical details.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.

## Just Completed

* **Agent Panel UX v1:** primary view hides Thought/tool noise; `presentAgentRun` / `summarizeAgentActivities` map tools → families; recovered failures stay in details only. Preview: `/dev/agent-panel-ux` (dev only).

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).

## Verification Status

| Check | Status |
|---|---|
| web tests | **Pass** (80) |
| web typecheck | **Pass** |
| `git diff --check` | **Pass** |
| Visual fixtures `/dev/agent-panel-ux` | **Reviewed** |
| Live authenticated agent run in browse | **Blocked** (no session) |

## Intentionally Deferred

* Engine keepNext/keepLines/lineSpacing/indent fields
* Live in-app agent screenshot pass (needs signed-in browse session)

## Recommended Next Step

Signed-in browser pass on a real agent run to confirm live SSE → new progress UI end-to-end.
