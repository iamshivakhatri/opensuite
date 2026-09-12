# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v5.3** + **AgentCore v2 Steps 1–5C**.
* **Document Authoring Intelligence v1** + list≠grouping + **insert_paragraphs rejects embedded newlines**.
* Confirmation bridge; Frontend Phases 1–6B; hosted-alpha foundation.

## Just Completed

* **insert_paragraphs:** each `texts[]` entry is one paragraph; `\r`/`\n` → `INVALID_TOOL_INPUT`; tool copy tells model to use multiple entries + spacing/style.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; **AgentCore v2 frozen** unless evidence-backed fixes.
* Engine keep*/indent deferred until visible multi-page need.

## Verification Status

| Check | Status |
|---|---|
| agent-core tests | **Pass** (204) |
| API agent.bench | **Pass** (4/4) |
| `git diff --check` | **Pass** |
| Catalog size | **23.9KB** (<24KB) |

## Intentionally Deferred

* Engine keepNext/keepLines/lineSpacing/indent fields
* Agent panel UX polish

## Recommended Next Step

Agent panel UX (authoring guidance B closed).
