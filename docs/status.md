# OpenSuite — Status

_Read this before starting any work. Keep it a concise current-state handoff, not a diary — overwrite stale sections rather than appending to them._

## What Exists

* Monorepo (pnpm + Turborepo + TypeScript). Auth v1 complete.
* `packages/db` — Better Auth + product tables (`workspace`, `document`, `document_version`).
* Workspace API: `GET/POST /api/workspaces` (owner-scoped).
* **Document upload (this milestone):** `POST /api/workspaces/:workspaceId/documents` (multipart, `.docx`/`.pptx`/`.xlsx`).
* S3-compatible storage boundary in `apps/api` (`ObjectStorage` → AWS SDK). Works with MinIO; app code is not MinIO-specific.
* Engine boundary paused at `inspect_document`. No download/list UI, versioning UI, or agent/engine product loop yet.

## Just Completed

First Office document upload path:

* Auth + workspace ownership checks; bytes → object storage; then `document` + `document_version` v1 in one DB transaction
* On DB failure after put → best-effort `deleteObject`
* Storage key: `workspaces/{workspaceId}/documents/{documentId}/versions/{versionId}/content.{format}`
* Config: canonical `S3_*` (legacy `MINIO_*` still accepted as fallback)

## Current Decisions

* Postgres stores `storage_key` only (never MinIO/S3 URLs).
* Bucket is configured externally — app does not auto-create buckets.
* Upload max size: `UPLOAD_MAX_BYTES` (default 25 MiB).
* `sha256` left null for this milestone.

## Verification Status

| Check | Status |
|---|---|
| `pnpm typecheck` / `pnpm build` / `pnpm test` | **Pass** |
| `RUN_DB_INTEGRATION_TESTS=true` | **Pass** (28/28) |
| Live MinIO upload (bucket `opensuite`) | **Pass** — object + document + version 1 rows confirmed |

## Intentionally Deferred

* Document list/download APIs, frontend upload UI
* Version 2+, folders, sharing, members
* Agent-core / engine integration

## Recommended Next Step

Add **document list + download** for an owned workspace (`GET` documents, stream bytes via storage key) so the upload path is usable end-to-end before any UI polish.
