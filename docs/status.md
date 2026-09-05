# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Auth + workspace-first product shell (Workspaces / Recent / Starred / Write / Slides / Sheets / Settings).
* Workspace CRUD (create, rename, soft-delete) + summary list (counts + recent filenames).
* Per-user `document_user_state` (star + last-opened) for Recent/Starred.
* Workspace IDE: explorer + session tabs + placeholder canvas + document-scoped Agent.
* Agent persistence + execution + SSE streaming (unchanged).

## Just Completed

* `/app` = workspaces home (not implicit file library).
* Routes: `/app/workspaces/:id`, `/app/workspaces/:id/documents/:id`; old `/app/documents/:id` redirects.
* Functional sidebar (no Shared); Settings account + theme (system/light/dark).
* Format libraries with destination-workspace upload.

## Current Decisions

* Document-first agent only — no workspace-wide agent yet.
* Soft-delete workspaces/documents; history retained.
* Mock mutations in-memory per run — do not modify Office binaries yet.
* `pnpm db:migrate` required after schema pulls (`document_user_state`).

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `RUN_DB_INTEGRATION_TESTS=true` (workspace rename/delete, recent/starred) | **Pass** |
| `pnpm build` | **Pass** |
| Real Office rendering / binary mutation | **Not implemented** |

## Intentionally Deferred

* Real Office binary mutation / Rust engine / document_version from agent
* Workspace-scoped agent / folders / sharing / collaboration
* Blank-document creation / Trash / checkpoints

## Recommended Next Step

Manual QA the workspace-first flow (create → open → upload → star → recent → settings), then engine-backed DocumentRuntime when ready.
