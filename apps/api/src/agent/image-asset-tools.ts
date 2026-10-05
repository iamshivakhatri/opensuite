import { jsonSchema } from "ai";
import { defineTool, type AgentToolSet } from "@opensuite/agent-core-v3";
import {
  ENGINE_IMAGE_CONTENT_TYPES,
  WorkspaceAssetError,
  type EngineImageContentType,
  type WorkspaceAssetService,
} from "../workspace-brand/assets.js";
import { assetMaxBytes } from "../workspace-brand/validation.js";
import { WorkspaceAccessError } from "../workspaces/service.js";

type AssetReader = Pick<WorkspaceAssetService, "readBytes" | "listImages">;
type Mutate = (
  capability: string,
  operation: Record<string, unknown>,
) => Promise<unknown>;

const placementSchema = {
  type: "object",
  description:
    "Use start/end without a handle at document boundaries. For before/after, use a fresh body_blocks handle from document.inspect.",
  properties: {
    kind: { type: "string", enum: ["start", "end", "before", "after"] },
    handle: { type: "string" },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

const imagePosition = (references: string[]) => ({
  type: "object",
  additionalProperties: false,
  required: ["reference"],
  properties: {
    reference: { type: "string", enum: references },
    alignment: { type: "string", enum: ["start", "center", "end"] },
    offsetEmu: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
  },
  oneOf: [{ required: ["alignment"] }, { required: ["offsetEmu"] }],
});

const floatingLayoutSchema = {
  type: "object",
  additionalProperties: false,
  required: ["horizontal", "vertical"],
  properties: {
    horizontal: imagePosition(["page", "margin", "column"]),
    vertical: imagePosition(["page", "margin", "paragraph"]),
    wrap: {
      type: "string",
      enum: ["square", "topAndBottom", "behindText", "inFrontOfText"],
    },
    distance: {
      type: "object",
      additionalProperties: false,
      minProperties: 1,
      properties: Object.fromEntries(
        ["topEmu", "bottomEmu", "leftEmu", "rightEmu"].map((key) => [
          key,
          { type: "integer", minimum: 0, maximum: 4294967295 },
        ]),
      ),
    },
  },
} as const;

function isEngineImageContentType(value: string): value is EngineImageContentType {
  return (ENGINE_IMAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

function toolError(error: unknown): never {
  if (error instanceof WorkspaceAccessError || error instanceof WorkspaceAssetError) {
    throw new Error(error.message);
  }
  throw error;
}

/** Authorize, load once, and validate stored MIME/size for engine picture ops. */
export async function resolveOwnedEngineImage(
  assets: AssetReader,
  workspaceId: string,
  userId: string,
  assetId: string,
): Promise<{ bytes: Buffer; contentType: EngineImageContentType }> {
  const loaded = await assets.readBytes(workspaceId, userId, assetId).catch(toolError);
  if (!isEngineImageContentType(loaded.contentType)) {
    throw new Error(
      "Only PNG and JPEG workspace images can be inserted into documents",
    );
  }
  if (loaded.bytes.length === 0 || loaded.bytes.length > assetMaxBytes) {
    throw new Error("Workspace image exceeds the allowed size");
  }
  return { bytes: loaded.bytes, contentType: loaded.contentType };
}

/** Model-facing asset-ID tools; bytes stay application-side. */
export function createImageAssetTools(input: {
  readonly assets: AssetReader;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly mutate?: Mutate;
  readonly canInsert?: boolean;
  readonly canReplace?: boolean;
}): AgentToolSet {
  const tools: AgentToolSet = {
    "document.list_image_assets": defineTool({
      kind: "read",
      description:
        "List owned workspace PNG/JPEG image assets the agent can insert or use as replacements. Returns compact metadata and asset IDs only — never image bytes. Page with offset/limit (default 20, max 50).",
      inputSchema: jsonSchema<{ offset?: number; limit?: number }>({
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      }),
      execute: async (args) =>
        input.assets
          .listImages(input.workspaceId, input.ownerUserId, args ?? {})
          .catch(toolError),
    }),
  };

  if (input.mutate && input.canInsert !== false) {
    tools["document.insert_image_asset"] = defineTool({
      kind: "mutate",
      description:
        "Insert an owned workspace image asset into the active DOCX by asset ID. Resolves authorized stored bytes server-side; pass assetId from document.list_image_assets, never bytes. Placement uses start/end or before/after with a fresh body_blocks handle. Optional widthEmu/heightEmu (one dimension preserves aspect ratio). Optional floating layout uses supported wrap/position; omit layout for inline. EMU: 914,400 per inch. Re-inspect after editing.",
      inputSchema: jsonSchema<{
        assetId: string;
        placement: { kind: string; handle?: string };
        widthEmu?: number;
        heightEmu?: number;
        altText?: string;
        layout?: Record<string, unknown>;
      }>({
        type: "object",
        properties: {
          assetId: { type: "string", format: "uuid" },
          placement: placementSchema,
          widthEmu: { type: "integer", minimum: 1, maximum: 4294967295 },
          heightEmu: { type: "integer", minimum: 1, maximum: 4294967295 },
          altText: { type: "string", maxLength: 512 },
          layout: floatingLayoutSchema,
        },
        required: ["assetId", "placement"],
        additionalProperties: false,
      }),
      execute: async (args) => {
        const image = await resolveOwnedEngineImage(
          input.assets,
          input.workspaceId,
          input.ownerUserId,
          args.assetId,
        );
        return input.mutate!("insert_picture", {
          imageBytes: image.bytes,
          placement: args.placement,
          ...(args.widthEmu !== undefined ? { widthEmu: args.widthEmu } : {}),
          ...(args.heightEmu !== undefined ? { heightEmu: args.heightEmu } : {}),
          ...(args.altText !== undefined ? { altText: args.altText } : {}),
          ...(args.layout !== undefined ? { layout: args.layout } : {}),
        });
      },
    });
  }

  if (input.mutate && input.canReplace !== false) {
    tools["document.replace_image_asset"] = defineTool({
      kind: "mutate",
      description:
        "Replace an existing picture with an owned workspace image asset. Pass a fresh inspect_layout or body_blocks picture handle and assetId from document.list_image_assets. The replacement must be the same PNG/JPEG content type as the existing picture. Preserves current size, inline/floating mode, placement, and wrapping. Re-inspect after editing.",
      inputSchema: jsonSchema<{ handle: string; assetId: string }>({
        type: "object",
        properties: {
          handle: { type: "string", minLength: 1 },
          assetId: { type: "string", format: "uuid" },
        },
        required: ["handle", "assetId"],
        additionalProperties: false,
      }),
      execute: async (args) => {
        const image = await resolveOwnedEngineImage(
          input.assets,
          input.workspaceId,
          input.ownerUserId,
          args.assetId,
        );
        return input.mutate!("replace_picture", {
          handle: args.handle,
          replacementBytes: image.bytes,
          contentType: image.contentType,
        });
      },
    });
  }

  return tools;
}
