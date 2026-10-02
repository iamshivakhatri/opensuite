import { jsonSchema } from "ai";
import { defineTool, type AgentEvent, type AgentToolSet } from "@opensuite/agent-core-v3";

const COMMON_TOOLS = new Set([
  "document.inspect", "document.find", "document.replace_text", "document.batch_replace_text",
  "document.insert_paragraphs", "document.set_paragraph_style", "document.create_table",
  "document.set_table_cells_text", "document.delete_table_row",
  "workspace.create_blank_document", "workspace.duplicate_current_document",
  "workspace.select_document", "workspace.inspect_document", "workspace.rename_document", "finish", "finish_with_input_needed",
  "workspace.search_documents", "request_clarification",
]);

const TOOL_GROUPS = {
  paragraphs: {
    description: "Insert or delete single paragraphs, format spacing and lists, and apply paragraph styles in batches.",
    tools: ["insert_paragraph", "delete_paragraph", "set_paragraph_formatting", "set_paragraphs_list", "batch_paragraph_styles", "batch_paragraph_formatting"],
  },
  text_formatting: {
    description: "Change body or partial text-span appearance, individually or in batches; use table_styling for known whole cells.",
    tools: ["set_text_formatting", "batch_text_formatting"],
  },
  table_styling: {
    description: "Change table borders, alignment, margins, widths, and known table-cell shading or text appearance.",
    tools: ["set_table_formatting", "set_table_column_widths", "set_table_cell_shading", "set_table_cells_formatting"],
  },
  table_structure: {
    description: "Add table rows or columns, remove columns, and delete whole tables.",
    tools: ["insert_table_rows", "insert_table_row", "insert_table_column", "delete_table_column", "delete_table"],
  },
  page_layout: {
    description: "Change page breaks, margins, paper size, orientation, headers, footers, and page numbers.",
    tools: ["insert_page_break", "delete_page_break", "set_page_setup", "set_header_footer_text", "set_page_number"],
  },
  rich_content: {
    description: "Edit content controls and hyperlinks, resize pictures, and remove pictures.",
    tools: ["set_content_control_text", "set_hyperlink", "set_picture_size", "delete_picture"],
  },
} as const;

type ToolGroup = keyof typeof TOOL_GROUPS;
const LOAD_GROUP = "tools.load_group";

/** One run's view over the already capability-filtered tools; no new dispatch path. */
export function createToolSurface(tools: AgentToolSet) {
  const groupNames = (Object.keys(TOOL_GROUPS) as ToolGroup[]).sort()
    .filter((group) => TOOL_GROUPS[group].tools.some((name) => tools[`document.${name}`]));
  const active = new Set<ToolGroup>();
  const activeGroups = () => groupNames.filter((group) => active.has(group));
  let discoveryTurnCount = 0;
  let turnGroups: ToolGroup[] = [];

  const loader = defineTool<{ groups: string[] }, unknown>({
    kind: "read",
    description: "Load one or more capability groups. Their tools become available on the next model turn and stay loaded for this run.",
    inputSchema: jsonSchema({
      type: "object",
      properties: { groups: { type: "array", minItems: 1, maxItems: groupNames.length || 1, items: { type: "string", enum: groupNames } } },
      required: ["groups"], additionalProperties: false,
    }),
    execute: ({ groups }) => {
      if (!Array.isArray(groups) || !groups.length || groups.some((group) => !groupNames.includes(group as ToolGroup))) {
        return { ok: false, reasonCode: "UNKNOWN_TOOL_GROUP" };
      }
      for (const group of groups) active.add(group as ToolGroup);
      return { ok: true, activeGroups: activeGroups() };
    },
  });
  const registry: AgentToolSet = { ...tools, ...(groupNames.length ? { [LOAD_GROUP]: loader } : {}) };
  const projectTools = () => {
    const names = new Set(COMMON_TOOLS);
    for (const group of activeGroups()) {
      for (const name of TOOL_GROUPS[group].tools) names.add(`document.${name}`);
    }
    names.add(LOAD_GROUP);
    return Object.fromEntries(Object.keys(registry).sort().filter((name) => names.has(name)).map((name) => [name, registry[name]!])) as AgentToolSet;
  };

  const initialTools = projectTools();
  const initialToolCount = Object.keys(initialTools).length;
  let peakToolCount = initialToolCount;
  return {
    tools: registry,
    initialTools,
    capabilityIndex: groupNames.map((group) => `${group}: ${TOOL_GROUPS[group].description}`).join("\n"),
    projectTools: () => {
      turnGroups = activeGroups();
      const selected = projectTools();
      peakToolCount = Math.max(peakToolCount, Object.keys(selected).length);
      return selected;
    },
    recordTurn(event: Extract<AgentEvent, { type: "model_turn_completed" }>, run: string) {
      const count = event.exposedToolCount ?? 0;
      const discovery = event.toolNames.includes(LOAD_GROUP);
      if (discovery) discoveryTurnCount++;
      console.info(`[agent] tool_surface run=${run} turn=${event.turn} exposedToolCount=${count} exposedToolSchemaChars=${event.exposedToolSchemaChars ?? 0} activeGroups=${turnGroups.join(",") || "none"} discoveryTurn=${discovery}`);
    },
    summary: () => ({ initialToolCount, peakToolCount, groupsLoaded: activeGroups(), discoveryTurnCount }),
  };
}
