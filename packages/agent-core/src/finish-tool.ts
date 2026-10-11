import { jsonSchema } from "ai";

import { defineTool, type AgentTool } from "./types.js";

/**
 * A generic terminal ("finish") tool. Calling it ends the run without spending
 * another model turn on a bare confirmation. The final assistant text is
 * streamed normally in the same turn; this tool only marks that turn complete.
 * Hosts may define their own terminal tool instead — this is only a convenience
 * for the common case.
 */
export function createFinishTool(options?: {
  readonly name?: string;
  readonly description?: string;
}): { readonly name: string; readonly tool: AgentTool } {
  const name = options?.name ?? "finish";
  const tool = defineTool<Record<string, never>, string>({
    kind: "read",
    terminal: true,
    description:
      options?.description ??
      "After your concise final response to the user, call this to end the run.",
    inputSchema: jsonSchema<Record<string, never>>({
      type: "object",
      properties: {},
      additionalProperties: false,
    }),
    execute: () => "",
  });
  return { name, tool };
}
