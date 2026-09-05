# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Workspace-first shell: Workspaces / Recent / Starred / Write / Slides / Sheets / Trash / Settings.
* Workspace + document rename, soft-delete (Trash), restore.
* Per-user star + last-opened; format libraries.
* Workspace IDE: explorer menus, tabs, placeholder canvas, document Agent.
* Agent persistence + SSE (document-scoped; deleted docs blocked).

## Just Completed

* Document `PATCH` rename (format-preserving) + `DELETE` soft-delete.
* `GET /api/trash`, `POST …/restore` for workspaces and documents.
* Document restore requires active parent workspace (`409 WORKSPACE_DELETED`).
* Removed unused FilesView / localStorage workspace-selection UI.

## Current Decisions

* Soft-delete only — no permanent delete / retention jobs yet.
* Trash lists owned deleted workspaces + individually deleted documents.
* Mock mutations in-memory — do not modify Office binaries yet.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` | **Pass** |
| `pnpm test` | **Pass** |
| `RUN_DB_INTEGRATION_TESTS=true` (rename/trash/restore) | **Pass** |
| `pnpm build` | **Pass** |
| Real Office rendering / binary mutation | **Not implemented** |

## Intentionally Deferred

* Permanent delete / retention
* Real Office mutation / Rust engine / folders / sharing
* Workspace-scoped agent / blank-document creation

## Recommended Next Step

Manual QA rename → Trash → restore (doc + workspace), then engine-backed DocumentRuntime when ready.
