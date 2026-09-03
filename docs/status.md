# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Monorepo (pnpm + Turborepo + TypeScript). Auth v1 complete (`apps/api` Better Auth + Resend; `apps/web` sign-in/up/verify/reset).
* `packages/db` — PostgreSQL + Drizzle with:
  * Better Auth tables (`user`, `session`, `account`, `verification`)
  * **Product tables (this milestone):** `workspace`, `document`, `document_version` — migration `0001_flashy_rhino` applied to `opensuite`
* Engine boundary paused at `inspect_document` (`packages/contracts`, `packages/engine-client`).
* No product API routes, MinIO, upload, or workspace UI yet.

## Just Completed

First OpenSuite product database model in `packages/db/src/schema/product.ts`:

* `workspace` — owned by Better Auth `user` (`owner_user_id`, soft `deleted_at`)
* `document` — belongs to workspace (`format` enum `docx|pptx|xlsx`, soft `deleted_at`); **no** `current_version_id`
* `document_version` — immutable snapshot (`storage_key` object key, `size_bytes`, nullable `sha256`, `source` enum, nullable `parent_version_id` + `created_by_user_id`); unique `(document_id, version_number)`; check `version_number > 0`

FKs use `ON DELETE RESTRICT` (history-safe) except `created_by_user_id` → `SET NULL`. Indexes: `workspace(owner_user_id)`, `document(workspace_id)`, unique on version pair.

## Current Decisions

* Auth schema owned by Better Auth; product tables FK to `user.id` without competing user tables.
* Latest document version = highest `version_number` (no pointer column).
* `storage_key` is an object-storage key, not a URL; bytes stay out of Postgres.
* Workspace is not auto-created on signup.
* Hard deletes are explicit product workflows later — no cascade wipe of document/version history.

## Verification Status

| Check | Status |
|---|---|
| `pnpm db:generate` → `0001_flashy_rhino.sql` | **Pass** (inspected before apply) |
| `pnpm db:migrate` | **Pass** — tables/enums/FKs/indexes/check confirmed in `opensuite` |
| `pnpm typecheck` / `pnpm build` / `pnpm test` | **Pass** |
| `packages/db` product schema unit tests | **Pass** (4 new) |

## Intentionally Deferred

* Workspace/document API + services, MinIO/S3, uploads, frontend file browsing
* Workspace members, folders, sharing, stars/recent
* Agent tables, agent-core, engine integration, OAuth

## Recommended Next Step

Add the first **workspace + document API** in `apps/api` (create workspace for the authenticated user, create document metadata + first version row with a placeholder `storage_key` contract) — still without MinIO if needed, or pair with a minimal storage client next if uploads are the priority.
