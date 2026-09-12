# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace shell, Casual Docs DOCX, engine-backed inspect/mutate, blank create, workspace agent.
* **Agent Efficiency v1–v5.3** + **AgentCore v2 Steps 1–5C** (formatting batching, scripted benches, occurrence targeting).
* **Document Authoring Intelligence v1:** genre-agnostic AUTHORING prompt + semantic tool descriptions; post-create catalog includes style/spacing/list; deterministic creative/memo/guide scenarios.
* Confirmation bridge; Frontend Phases 1–6B + shell/format unification; hosted-alpha foundation (auth, BYOK, OpenRouter, trial, quota, purge, Settings, Trash).

## Just Completed

* **Document Authoring Intelligence v1** — model decides structure/presentation from intent + catalog capabilities (no genre templates). Verified: agent-core **201** tests; API bench incl. authoring scenarios; catalog **23.5KB**; `git diff --check` clean. Engine-backed sample DOCX show Heading1 + spacing/list applied.

## Current Decisions

* Soft-delete; optimistic concurrency; Rust SoT; `pnpm dev:api` rebuilds agent-core first.
* Managed AI gateway = OpenRouter; authoritative cost from `usage.cost`.
* **AgentCore v2 frozen** unless evidence-backed fixes.
* Paragraph formatting N-API: alignment + spacingBefore/After only; keep*/indent await engine (styles already carry keepNext on Title/Heading).

## Verification Status

| Check | Status |
|---|---|
| agent-core typecheck/tests | **Pass** (201) |
| API typecheck + agent.bench | **Pass** (4/4) |
| `git diff --check` | **Pass** |
| Authoring sample DOCX (scripted native) | **Pass** — Heading/spacing/list in OOXML |
| Live app GUI screenshots | **Not done** — no browser pass this milestone |

## Intentionally Deferred

* keepNext/keepLines/lineSpacing/indent as explicit paragraph-formatting fields (engine)
* Live model GUI visual pass (creative/memo/guide in Casual Docs)
* Planner/DAG; billing UI; confirmation durable resume

## Recommended Next Step

Live-app visual pass: prompt creative / memo / guide documents and judge hierarchy, spacing, grouping in the editor.
