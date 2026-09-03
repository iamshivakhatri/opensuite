# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Monorepo (pnpm + Turborepo + TypeScript). Auth v1 complete (`apps/api` Better Auth + Resend; `apps/web` sign-in/up/verify/reset).
* `packages/db` — PostgreSQL + Drizzle: Better Auth tables + product tables (`workspace`, `document`, `document_version`; migration `0001_flashy_rhino`).
* **Product API (this milestone):** authenticated workspace routes in `apps/api`:
  * `GET /api/workspaces` — list non-deleted workspaces owned by the session user
  * `POST /api/workspaces` — create workspace for the session user (`{ name }`, trimmed/validated)
* Engine boundary paused at `inspect_document`. No MinIO, document routes, or workspace UI yet.

## Just Completed

Authenticated workspace API in `apps/api`:

* Thin routes in `routes/workspaces.ts` using `getRequestUser`
* `createWorkspaceService(db)` in `workspaces/service.ts` — `listOwned` / `create` only; DTO `{ id, name, createdAt, updatedAt }`
* `buildApp` now takes `{ auth, db }`

## Current Decisions

* Workspace ownership always comes from the session user — never from the request body.
* Soft-deleted workspaces (`deleted_at`) are excluded from list; hard delete still deferred.
* Workspace is not auto-created on signup.
* Latest document version = highest `version_number` (no pointer column).

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` / `pnpm build` / `pnpm test` | **Pass** |
| `RUN_DB_INTEGRATION_TESTS=true` (auth + workspace) | **Pass** (20/20) |

## Intentionally Deferred

* Document API, MinIO/S3, uploads, frontend workspace UI
* Workspace members, folders, sharing
* Agent tables, agent-core, engine integration

## Recommended Next Step

Add the first **document API** for an owned workspace (create document metadata + first `document_version` with a placeholder `storage_key` contract) — still without MinIO if uploads are not the priority.
