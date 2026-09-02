# OpenSuite — Agent Instructions

OpenSuite is a long-term open-source, AI-native Office productivity system.

The product repository is separate from `opensuite-engine`, the Rust document engine.

## Product Goal

OpenSuite should eventually support this loop:

    user intent
    → understand document
    → inspect through OpenSuite Engine
    → plan typed operations
    → execute safely
    → receive structured diagnostics
    → render affected pages/slides
    → visually inspect
    → self-correct when necessary
    → return the final artifact

This is NOT a generic coding agent or generic chat application.

## Repository Responsibilities

This repository owns:

* web application
* backend API
* authentication
* users and workspaces
* file/version management
* persistence
* agent runtime
* engine client
* deployment/infrastructure

This repository does NOT implement Office document internals.

DOCX/PPTX/XLSX parsing, mutation, validation, rendering, preservation logic, and document diagnostics belong in the separate Rust `opensuite-engine` repository.

## Repository Structure

```text
apps/
  web/            # Next.js/React web application (not yet implemented)
  api/            # Backend API service (not yet implemented)

packages/
  agent-core/     # Model runtime + tool orchestration (not yet implemented)
  engine-client/  # Only package allowed to talk to opensuite-engine (not yet implemented)
  contracts/      # Shared types/schemas used across packages (not yet implemented)
  db/             # Persistence layer: schema, migrations, data access (not yet implemented)

docs/             # Architecture and process documentation
```

Managed with pnpm workspaces + Turborepo. Every package/app is TypeScript.

Currently every app/package is scaffolding only (`package.json`, `tsconfig.json`, a placeholder `src/index.ts`). No frontend, backend, database, agent, auth, or engine integration has been implemented yet. Do not assume otherwise — check `docs/status.md` for the true current state before working.

## Architecture Rules

1. Preserve strict boundaries between:

   * web (`apps/web`)
   * API (`apps/api`)
   * agent-core (`packages/agent-core`)
   * engine-client (`packages/engine-client`)
   * db (`packages/db`)
   * contracts (`packages/contracts`)
   * the Rust engine (`opensuite-engine`, separate repository)

2. `agent-core` must not:

   * directly access databases
   * directly manipulate DOCX/PPTX/XLSX
   * own authentication
   * own file storage
   * contain product-specific UI logic

3. `engine-client` is the only application-layer package that communicates with `opensuite-engine`.

4. Agent document mutations must use typed engine operations.

5. Do not introduce arbitrary shell/filesystem access as agent capabilities.

6. Document mutations should be auditable and deterministic wherever practical.

7. Prefer explicit contracts (`packages/contracts`) over loosely typed shared objects.

8. Major architecture decisions require human approval before implementation.

## Before You Start Working

Every coding agent must, before making changes:

1. Read `Agents.md` (this file) in full.
2. Read `docs/status.md` — the current-state handoff. It tells you what exists, what was just done, and the single recommended next step.
3. Read whichever files under `docs/` are relevant to the area you are about to touch (`docs/architecture.md`, `docs/agent_core.md`, `docs/engine_integration.md`, etc.).
4. Read and understand the existing code you are about to modify — do not edit code you have not read.

## While Working

* Work on one focused concern at a time. Do not bundle unrelated changes into a single piece of work.
* Never silently invent major architecture. If a decision isn't already established in `docs/`, surface it and get agreement before building on top of it.
* Avoid unrelated refactors. If you notice something worth improving outside your current scope, mention it instead of fixing it inline.
* Preserve the boundaries between `apps/web`, `apps/api`, `packages/agent-core`, `packages/engine-client`, `packages/db`, `packages/contracts`, and `opensuite-engine`. Do not reach across a boundary as a shortcut.
* Do not add infrastructure "because it may be useful later."
* Do not add placeholder abstractions without an immediate, concrete use.
* Prefer boring, understandable code over clever abstractions.
* Implement the smallest coherent change that satisfies the task.
* Run relevant checks/tests (e.g. `pnpm build`, `pnpm typecheck`) before considering work done.

## After Working

1. Summarize what changed.
2. Update `docs/status.md` after any meaningful work — keep it a concise current-state handoff (what exists, what just changed, current decisions, what's deferred, one recommended next step), not a running diary or changelog.
3. Do not start the next recommended task unless explicitly asked to.

## Development Philosophy

Work vertically and incrementally.

Each milestone should prove one real architectural path before adding additional complexity.

Architecture first.
Contracts second.
Implementation third.

## Frontend

An HTML design reference exists in the repository (`opensuite_v4_modern_minimal.html`).

Treat it as the visual source of truth.

Do not redesign OpenSuite unless explicitly requested.

When translating it into the application:

* preserve visual hierarchy
* preserve spacing and proportions
* preserve the minimal aesthetic
* break the HTML into maintainable React components
* avoid turning every small element into its own component
* use the existing design rather than introducing a generic dashboard template

The web application will be deployed on Vercel.

## Technology Direction

Default direction unless an ADR changes it:

* TypeScript
* Next.js for web
* React
* pnpm workspaces + Turborepo
* separate API/runtime service
* TypeScript agent-core
* Rust `opensuite-engine` maintained independently

## Quality Bar

OpenSuite is intended to become serious infrastructure, not a prototype that permanently accumulates prototype architecture.

Optimize for:

* correctness
* explicit boundaries
* observability
* recoverability
* testability
* maintainability
* strong typing
* long-term open-source readability
