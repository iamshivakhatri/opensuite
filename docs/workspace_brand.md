# Workspace Brand & Styles

Phase 4 stores explicit workspace preferences; it does not change documents or add model context.

The persistent workspace shell renders `/app/workspaces/[workspaceId]/brand`. Its quiet sidebar link sits above Add file. Brand is the default tab; Saved Styles uses the existing personal Phase 2 profiles across workspaces.

`WorkspaceBrandData` schema version 1 contains company/contact fields, nullable primary/secondary/accent hex colors, font names, header/footer text and visibility preferences. `WorkspaceBrandProfile` adds workspace identity and timestamps. Only company name is required; other text can be empty and colors can be null. Six-digit colors normalize to uppercase. Font names express preferences, not bundled fonts.

Migration `0024_workspace_brand` adds:

- `workspace_brand`: workspace primary key, versioned JSON settings, separate logo asset foreign key, timestamps.
- `workspace_asset`: image ID, workspace foreign key, unique object-storage key, content type, size and creation time.

Authenticated endpoints:

- `GET /api/workspaces/:workspaceId/brand`: profile or null.
- `PUT /api/workspaces/:workspaceId/brand`: validated complete settings, upserted by the small brand service.
- `POST /api/workspaces/:workspaceId/assets`: one multipart PNG/JPEG/WebP, at most 2 MB, checked by file signature.
- `GET /api/workspaces/:workspaceId/assets/:assetId`: private image stream after workspace and asset ownership checks.
- `DELETE /api/workspaces/:workspaceId/assets/:assetId`: remove only an unreferenced image in this workspace.

All access reuses `WorkspaceService.getOwned`; the current product grants workspace access to its owner. Writes lock the workspace, like purge. Asset IDs from another workspace cannot be attached, read or deleted. Images use existing object storage and quota accounting. Replaced/removed logos are cleaned after save; permanent workspace purge removes remaining assets and releases recorded bytes.

The form keeps selected files locally until Save. Failed saves attempt to remove newly uploaded, unreferenced images. Interrupted uploads or failed cleanup can retain unused assets and their quota until workspace purge; there is no background asset collector. The live preview is ordinary HTML, uses available local fonts, and is approximate.

Checks: API/web typecheck, API build, webpack web build, and `RUN_BRAND_DB_TESTS=true node --test apps/api/dist/workspace-brand/service.test.js` after API build. The test uses a temporary PostgreSQL schema, applies the complete migration chain, and drops that schema afterward. No paid models or engine changes are needed.
