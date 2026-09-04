import type { AgentMessage, AgentRequest, AgentResource } from "./request.js";
import type { ToolRegistry } from "./tools.js";
import type { DocumentRef, RuntimeCapabilities } from "./types.js";

/**
 * Run-scoped context available to a future agent loop.
 * Not an untyped JSON dump; not provider prompt structures.
 */
export interface AgentRunContext {
  readonly request: AgentRequest;
  readonly messages: readonly AgentMessage[];
  readonly primaryDocument: DocumentRef | null;
  readonly contextualResources: readonly AgentResource[];
  readonly tools: ToolRegistry;
  readonly capabilities: RuntimeCapabilities;
  readonly signal: AbortSignal;
}

export function createAgentRunContext(input: {
  request: AgentRequest;
  messages?: readonly AgentMessage[];
  tools: ToolRegistry;
  capabilities: RuntimeCapabilities;
  signal?: AbortSignal;
}): AgentRunContext {
  return {
    request: input.request,
    messages: input.messages ?? [
      { role: "user", content: input.request.instruction },
    ],
    primaryDocument: input.request.primaryDocument ?? null,
    contextualResources: input.request.contextualResources ?? [],
    tools: input.tools,
    capabilities: input.capabilities,
    signal: input.signal ?? new AbortController().signal,
  };
}
