# Workspace Brand & Styles

Phase 4 stores organization identity; it does not change documents or add model context.

The persistent workspace shell renders `/app/workspaces/[workspaceId]/brand`. Its quiet sidebar link sits above Add file. Brand is the default tab; Saved Styles uses the existing personal Phase 2 profiles across workspaces.

`WorkspaceBrandData` schema version 1 contains company/contact fields, nullable primary/secondary/accent hex colors, and preferred heading/body font names. Contact facts remain under `organization` to preserve the existing simple v1 shape. `WorkspaceBrandProfile` adds workspace identity and timestamps. Only company name is required; other text can be empty and colors can be null. Six-digit colors normalize to uppercase. Font names express preferences, not bundled fonts.

Migration `0024_workspace_brand` adds:

- `workspace_brand`: workspace primary key, versioned JSON settings, separate logo asset foreign key, timestamps.
- `workspace_asset`: image ID, workspace foreign key, unique object-storage key, content type, size and creation time.

The unreleased v1 model no longer includes header/letterhead text, footer text, or logo/name/page-number visibility settings. Reads explicitly select identity fields and ignore obsolete `document` JSON from old development rows; the next save writes only identity fields. No migration is needed to clean that JSON.

Migration `0025_workspace_asset_images` adds nullable width, height and original byte size. Existing assets remain valid with unknown dimensions until replaced. `size_bytes` continues to track the actual stored, optimized bytes for quota and cleanup.

Sharp 0.35.4 was already in the lockfile through Next.js and is now declared directly by the API so backend-only installations include it. It decodes PNG/JPEG/WebP, normalizes orientation, strips metadata, caps the long edge at 2000 px without upscaling, and preserves transparency. PNG and WebP use lossless encoding; JPEG uses quality 95 and 4:4:4 color sampling. Inputs are limited to 40 million pixels and static raster images; SVG stays deferred.

Only the optimized object is stored and referenced. Keeping originals would introduce a second object lifecycle, quota record and purge path into the current one-object asset model. Original byte size is retained for debugging; old logos are optimized when uploaded again, without a background rewrite.

A generated transparent PNG test reduced 109,743 bytes at 3200×800 to 4,745 bytes at 2000×500. This is an illustrative test result, not a guarantee for every logo.

Authenticated endpoints:

- `GET /api/workspaces/:workspaceId/brand`: profile or null.
- `PUT /api/workspaces/:workspaceId/brand`: validated complete settings, upserted by the small brand service.
- `POST /api/workspaces/:workspaceId/assets`: one multipart PNG/JPEG/WebP, at most 2 MB, decoded and optimized before storage.
- `GET /api/workspaces/:workspaceId/assets/:assetId`: private image stream after workspace and asset ownership checks.
- `DELETE /api/workspaces/:workspaceId/assets/:assetId`: remove only an unreferenced image in this workspace.

All access reuses `WorkspaceService.getOwned`; the current product grants workspace access to its owner. Writes lock the workspace, like purge. Asset IDs from another workspace cannot be attached, read or deleted. Images use existing object storage and quota accounting. Replaced/removed logos are cleaned after save; permanent workspace purge removes remaining assets and releases recorded bytes.

The form keeps selected files locally until Save. Failed saves attempt to remove newly uploaded, unreferenced images. Interrupted uploads or failed cleanup can retain unused assets and their quota until workspace purge; there is no background asset collector. The live preview is ordinary HTML, uses available local fonts, and is approximate.

Checks: API/web typecheck, API build, webpack web build, and `RUN_BRAND_DB_TESTS=true node --test apps/api/dist/workspace-brand/images.test.js apps/api/dist/workspace-brand/service.test.js` after API build. The test uses a temporary PostgreSQL schema, applies the complete migration chain, and drops that schema afterward. No paid models or engine changes are needed.
