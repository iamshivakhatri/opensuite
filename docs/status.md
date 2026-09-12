# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.2** + **AgentCore v2 Steps 1–5C**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.

## Just Completed

* **Agent Efficiency v6.2:** deterministic document-tool working set uses generic families and run evidence; full execution registry and capability safety remain unchanged.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).

## Verification Status

| Check | Status |
|---|---|
| web tests | **Pass** (82) |
| web typecheck | **Pass** |
| `git diff --check` | **Pass** |
| agent-core tests/typecheck | **Pass** (206) |
| Visual `/dev/agent-panel-ux` | **Reviewed** (between-tools ≠ Finishing up; recovered muted) |
| Live signed-in agent run | **Blocked** (auth 403) |

## Intentionally Deferred

* Engine keepNext/keepLines/lineSpacing/indent fields
* Live in-app agent screenshot pass (needs signed-in session)

## Recommended Next Step

Run the complete real-provider benchmark when the provider run is available, then assess further recovery improvements.
