import { AgentCoreError, type AgentTool } from "@opensuite/agent-core";

import type { DocumentService } from "../documents/service.js";

export const WORKSPACE_TOOL_NAMES = {
  createBlankDocx: "workspace.create_blank_docx",
} as const;

export interface WorkspaceCreateBlankDocxResult {
  readonly document: {
    readonly documentId: string;
    readonly versionId: string;
    readonly format: "docx";
    readonly name: string;
    readonly versionNumber: number;
  };
}

/**
 * Application-owned workspace tool — not a DocumentRuntime mutation.
 * Creates a Rust blank DOCX via DocumentService and optionally promotes it
 * to the run's primary document for follow-on editing tools.
 */
export function createWorkspaceCreateBlankDocxTool(input: {
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly documents: Pick<DocumentService, "createBlankDocxDocument">;
}): AgentTool<
  { name?: string },
  WorkspaceCreateBlankDocxResult
> {
  const { workspaceId, ownerUserId, documents } = input;

  return {
    name: WORKSPACE_TOOL_NAMES.createBlankDocx,
    description:
      "Create a new blank Word (.docx) document in the current workspace. " +
      "When the user wants a NEW document, call this tool ALONE as your first action " +
      "(no inspect, no inserts in the same turn). " +
      "After it succeeds, author content with document mutation tools on the next turn. " +
      "Returns the new document id — it becomes the primary document for later tools in this run. " +
      "Do not invent other create-document tool names; create_blank_docx is an engine capability id, not a callable tool.",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          description:
            "Optional display name (with or without .docx). Defaults to Untitled Document.",
        },
      },
    },
    parseInput(raw: unknown): { name?: string } {
      if (raw === null || raw === undefined) {
        return {};
      }
      if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "workspace.create_blank_docx input must be an object",
        );
      }
      const name = (raw as { name?: unknown }).name;
      if (name === undefined || name === null || name === "") {
        return {};
      }
      if (typeof name !== "string") {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "workspace.create_blank_docx name must be a string",
        );
      }
      return { name: name.trim() || undefined };
    },
    async execute(args, ctx): Promise<WorkspaceCreateBlankDocxResult> {
      const created = await documents.createBlankDocxDocument({
        workspaceId,
        ownerUserId,
        ...(args.name ? { name: args.name } : {}),
      });

      const documentRef = {
        documentId: created.document.id,
        versionId: created.version.id,
        format: "docx" as const,
      };

      ctx.advancePrimaryDocument?.(documentRef);

      await ctx.events.emit({
        type: "document.created",
        runId: ctx.runId,
        documentId: created.document.id,
        versionId: created.version.id,
        name: created.document.name,
        format: "docx",
        at: new Date().toISOString(),
      });

      return {
        document: {
          documentId: created.document.id,
          versionId: created.version.id,
          format: "docx",
          name: created.document.name,
          versionNumber: created.version.versionNumber,
        },
      };
    },
  };
}
