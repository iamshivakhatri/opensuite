import { jsonSchema } from "ai";

import { defineTool, type AgentTool } from "./types.js";

/**
 * A generic terminal ("finish") tool. Calling it ends the run without spending
 * another model turn on a bare confirmation; the `summary` becomes the run's
 * final text. Hosts may define their own terminal tool instead — this is only a
 * convenience for the common case.
 */
export function createFinishTool(options?: {
  readonly name?: string;
  readonly description?: string;
}): { readonly name: string; readonly tool: AgentTool } {
  const name = options?.name ?? "finish";
  const tool = defineTool<{ summary?: string }, string>({
    kind: "read",
    terminal: true,
    description:
      options?.description ??
      "Call when the task is complete. Provide a short summary for the user. Ends the run.",
    inputSchema: jsonSchema<{ summary?: string }>({
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "Short natural-language summary of what was done.",
        },
      },
      additionalProperties: false,
    }),
    execute: ({ summary }) => summary ?? "",
  });
  return { name, tool };
}
