import { jsonSchema } from "ai";
import { defineTool, type AgentEvent, type AgentToolSet } from "@opensuite/agent-core";
import { isEngineDocumentTool } from "../../document-tools.js";
import { CapabilityRegistry, type CapabilityDefinition } from "../core/registry.js";
import { capabilityRegistry } from "../catalog.js";
import { CapabilitySession, type CapabilityEvent } from "../core/session.js";

/** Bind the process-wide catalog to this run's engine-filtered tools. */
export function createToolSurface(tools: AgentToolSet, emit?: (event: CapabilityEvent) => void) {
  let session!: CapabilitySession;
  let turn = 0;
  const discovery: AgentToolSet = {
    "capabilities.list": defineTool<{ parentId?: string | null }, unknown>({
      kind: "read", description: "List available children; omit parentId for domains. Entries show loadable and loaded state.",
      inputSchema: jsonSchema({ type: "object", properties: { parentId: { type: ["string", "null"] } }, additionalProperties: false }),
      execute: ({ parentId }) => session.list(parentId ?? null, turn),
    }),
    "capabilities.search": defineTool<{ query: string }, unknown>({
      kind: "read", description: "Find available capability IDs by name or description, with loadable and loaded state.",
      inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string", minLength: 2 } }, required: ["query"], additionalProperties: false }),
      execute: ({ query }) => session.search(query, turn),
    }),
    "capabilities.load": defineTool<{ ids: string[] }, unknown>({
      kind: "read", description: "Load exact loadable IDs. Tools stay available from the next turn. Repeated loads are harmless.",
      inputSchema: jsonSchema({ type: "object", properties: { ids: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } } }, required: ["ids"], additionalProperties: false }),
      execute: ({ ids }) => session.load(ids, turn),
    }),
  };
  const additions: CapabilityDefinition[] = Object.entries(tools)
    .filter(([name, tool]) => !capabilityRegistry.byToolName.has(name) && isEngineDocumentTool(tool))
    .map(([name, tool]) => ({ id: name, parentId: "document.more_operations", kind: "tool", toolName: name,
      title: name.slice("document.".length).replaceAll("_", " "), description: typeof tool.description === "string" ? tool.description : name, projection: "dynamic" }));
  const registry = additions.length ? new CapabilityRegistry([...capabilityRegistry.byId.values(), ...additions]) : capabilityRegistry;
  session = new CapabilitySession(registry, { ...tools, ...discovery }, emit);
  const initialTools = session.projectTools();
  let peakToolCount = Object.keys(initialTools).length;
  let discoveryTurnCount = 0;
  let turnLoaded: string[] = [];
  return {
    session,
    tools: session.tools,
    initialTools,
    capabilityIndex: session.roots().map((item) => `${item.id}: ${item.description}`).join("\n"),
    projectTools: (state?: { turn?: number }) => {
      turn = state?.turn ?? turn + 1;
      turnLoaded = [...session.loaded].sort();
      const selected = session.projectTools();
      peakToolCount = Math.max(peakToolCount, Object.keys(selected).length);
      return selected;
    },
    recordTurn(event: Extract<AgentEvent, { type: "model_turn_completed" }>, run: string) {
      const discoveryTurn = event.toolNames.some((name) => name.startsWith("capabilities."));
      if (discoveryTurn) discoveryTurnCount++;
      console.info(`[agent] capability_surface run=${run} turn=${event.turn} exposedToolCount=${event.exposedToolCount ?? 0} exposedToolSchemaChars=${event.exposedToolSchemaChars ?? 0} loaded=${turnLoaded.join(",") || "none"} discoveryTurn=${discoveryTurn}`);
    },
    summary: () => ({ initialToolCount: Object.keys(initialTools).length, peakToolCount, groupsLoaded: [...session.loaded].sort(), discoveryTurnCount }),
  };
}
