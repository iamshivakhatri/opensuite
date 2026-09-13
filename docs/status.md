# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.5** + **AgentCore v2 Steps 1–5C**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.

## Just Completed

* **Agent Efficiency v6.5:** successful paragraph inserts retain a bounded run-local list of exact texts for immediate styling. It has no invented occurrence; inspected paragraph data remains authoritative.
* Focused OpenRouter checks passed: `greenfield-poems` 5 turns / 13 tools / 0 failures, and `authoring-guide` 4 turns / 7 tools / 0 failures.

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
| agent-core tests/typecheck | **Pass** (211) |
| Provider benchmark | **Incomplete** (host exits after `simple-read`; no v6.4 pathological-scenario result) |
| Visual `/dev/agent-panel-ux` | **Reviewed** (between-tools ≠ Finishing up; recovered muted) |
| Live signed-in agent run | **Blocked** (auth 403) |

## Intentionally Deferred

* Engine keepNext/keepLines/lineSpacing/indent fields
* Live in-app agent screenshot pass (needs signed-in session)

## Recommended Next Step

Restore complete provider-benchmark execution, then compare v6.4 inspect reuse on pathological scenarios.
