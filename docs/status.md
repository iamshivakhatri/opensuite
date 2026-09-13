# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v6.6** + **AgentCore v2 Steps 1–5C**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* **Agent Panel UX v1.1** — live status from last activity (no premature Finishing up); inspect=`checks`; recovered details muted; slim composer.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.
* **AI Settings** — managed = credits bar only (card click applies); BYOK = provider → key → model → save; active strip shows what agent runs use.

## Just Completed

* **Theme hover:** sidebar (Home→Trash), lists, menus, and chrome use `primary-soft` / primary text — not grey. `--hover` token is primary-tinted.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.
* Agent progress presentation stays in `apps/web` (not agent-core).
* Managed model is server-chosen (`OPENROUTER_MODEL`); users do not pick it.
* Agent runs: valid BYOK preference wins; otherwise OpenSuite managed trial.

## Verification Status

| Check | Status |
|---|---|
| web tests | **Pass** (85) |
| web typecheck | **Pass** |
| `git diff --check` | **Pass** |
| agent-core tests/typecheck | **Pass** (214) |
| Provider benchmark | **Partially complete** (focused scenarios pass; full suite / `launch-brief` can exit without a final record) |
| Visual `/dev/agent-panel-ux` | **Reviewed** (between-tools ≠ Finishing up; recovered muted) |
| Live signed-in agent run | **Blocked** (auth 403) |

## Intentionally Deferred

* Engine keepNext/keepLines/lineSpacing/indent fields
* Live in-app agent screenshot pass (needs signed-in session)

## Recommended Next Step

Smoke workspace explorer + modal (create blank once, rename/edit unlocks another; upload drop), then resume provider-benchmark early-exit diagnosis.
