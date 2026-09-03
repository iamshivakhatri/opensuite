# OpenSuite — Agent Instructions

OpenSuite is a long-term open-source, AI-native Office productivity system.

This repository contains the product/application. Office document internals live in the separate Rust repository `opensuite-engine`.

Target loop:
user intent → inspect document → reason and plan typed operations → execute through OpenSuite Engine → validate/render → visually inspect and correct → return artifact

OpenSuite is not a generic chat or coding agent.

## Repository Map

```text
apps/
  web/            # Next.js frontend
  api/            # Fastify backend

packages/
  agent-core/     # model runtime + tool orchestration
  engine-client/  # only package that talks to opensuite-engine
  contracts/      # cross-boundary contracts
  db/             # PostgreSQL + Drizzle

docs/             # architecture + current-state docs look up to find more info if needed

```

## Boundaries

* Preserve boundaries between `web`, `api`, `agent-core`, `engine-client`, `contracts`, `db`, and `opensuite-engine`.
* `agent-core` must not directly access DB, storage, auth, UI, or Office internals.
* `engine-client` is the only product package allowed to communicate with `opensuite-engine`.
* Document mutations must use typed engine operations.
* Do not add arbitrary shell/filesystem capabilities to the document agent.
* Major architecture decisions require explicit user approval.

## Before Working

Always:

1. Read `docs/status.md`.
2. Inspect the existing code you will modify.
3. Read only the durable docs relevant to the task:
* `docs/architecture.md` — when changing package boundaries, system structure, deployment, or cross-package design
* `docs/agent_core.md` — when changing agent runtime/tool orchestration
* `docs/engine_integration.md` — when changing engine contracts/client/integration


4. If another doc under `docs/` is clearly relevant, read it too.

`docs/status.md` is the source of truth for current implementation state. If another durable doc under `docs/` is relevant, read it too.

## Working Rules

* One focused concern per task.
* Implement the smallest coherent change.
* Do not silently invent architecture.
* Avoid unrelated refactors.
* Do not add speculative infrastructure or abstractions.
* Prefer explicit, boring, understandable code.
* Preserve existing boundaries.
* Run relevant tests, typechecks, and builds.

## After Working

* Summarize what changed and what was verified.
* Update `docs/status.md` yet keep it concise & token efficient after meaningful work.
* Keep every md files under docs directory very concise. Don't try to bloat it

* Recommend one next step, but do not implement it unless asked.

## Development Philosophy

Architecture → contracts → implementation.

Build incrementally. Each milestone should prove one real path before adding more complexity.

## Frontend

`opensuite_v4_modern_minimal.html` is the visual reference.

Preserve its hierarchy, spacing, proportions, and minimal aesthetic. Do not replace it with a generic dashboard or chat UI.

## Default Stack

* TypeScript
* Next.js + React
* Fastify
* PostgreSQL + Drizzle
* pnpm + Turborepo
* TypeScript `agent-core`
* Separate Rust `opensuite-engine`

## Quality Bar

Optimize for correctness, explicit boundaries, testability, maintainability, recoverability, strong typing, and long-term open-source readability.