import { CapabilityRegistry, type CapabilityDefinition } from "./registry.js";
import { scientificPaperInstructions } from "./skills/scientific-paper.js";

const groups: CapabilityDefinition[] = [
  { id: "document", parentId: null, kind: "group", title: "Document", description: "Read and edit DOCX documents", projection: "dynamic" },
  { id: "document.paragraphs", parentId: "document", kind: "group", title: "Paragraphs", description: "Insert, delete, and format paragraphs and lists", projection: "dynamic" },
  { id: "document.text", parentId: "document", kind: "group", title: "Text", description: "Change text appearance", projection: "dynamic" },
  { id: "document.tables", parentId: "document", kind: "group", title: "Tables", description: "Edit table structure and appearance", projection: "dynamic" },
  { id: "document.tables.structure", parentId: "document.tables", kind: "group", title: "Table structure", description: "Add or delete table rows, columns, and tables", projection: "dynamic" },
  { id: "document.tables.styling", parentId: "document.tables", kind: "group", title: "Table styling", description: "Change table borders, widths, shading, and cell appearance", projection: "dynamic" },
  { id: "document.layout", parentId: "document", kind: "group", title: "Page layout", description: "Change page breaks, page setup, headers, and footers", projection: "dynamic" },
  { id: "document.rich_content", parentId: "document", kind: "group", title: "Rich content", description: "Edit links, content controls, and pictures", projection: "dynamic" },
  { id: "workspace", parentId: null, kind: "group", title: "Workspace", description: "Find, inspect, create, and select workspace files", projection: "dynamic" },
  { id: "agent", parentId: null, kind: "group", title: "Run controls", description: "Complete a task or ask for needed input", projection: "dynamic" },
  { id: "skills", parentId: null, kind: "group", title: "Writing skills", description: "Task-specific writing guidance", projection: "dynamic" },
  { id: "skills.scientific-writing", parentId: "skills", kind: "group", title: "Scientific writing", description: "Guidance for scientific documents", projection: "dynamic" },
  { id: "skills.scientific-writing.scientific-paper", parentId: "skills.scientific-writing", kind: "instruction", title: "Scientific Paper Writing", description: "Structure and evidence rules for drafting a scientific paper", aliases: ["write a research paper"], projection: "dynamic", instructions: scientificPaperInstructions },
];

const common = [
  "document.inspect", "document.find", "document.replace_text", "document.batch_replace_text",
  "document.insert_paragraphs", "document.set_paragraph_style", "document.create_table",
  "document.set_table_cells_text", "document.delete_table_row",
  "workspace.create_blank_document", "workspace.duplicate_current_document",
  "workspace.select_document", "workspace.inspect_document", "workspace.rename_document",
  "workspace.search_documents", "finish", "finish_with_input_needed", "request_clarification",
  "capabilities.list", "capabilities.search", "capabilities.load",
];

const dynamic: Record<string, readonly string[]> = {
  "document.paragraphs": ["insert_paragraph", "delete_paragraph", "set_paragraph_formatting", "set_paragraphs_list", "batch_paragraph_styles", "batch_paragraph_formatting"],
  "document.text": ["set_text_formatting", "batch_text_formatting"],
  "document.tables.structure": ["insert_table_rows", "insert_table_row", "insert_table_column", "delete_table_column", "delete_table"],
  "document.tables.styling": ["set_table_formatting", "set_table_column_widths", "set_table_cell_shading", "set_table_cells_formatting"],
  "document.layout": ["insert_page_break", "delete_page_break", "set_page_setup", "set_header_footer_text", "set_page_number"],
  "document.rich_content": ["set_content_control_text", "set_hyperlink", "set_picture_size", "delete_picture"],
};

const tool = (name: string, parentId: string, projection: "always" | "dynamic"): CapabilityDefinition => ({
  id: name, parentId, kind: "tool", title: name.replace(/^document\.|^workspace\./, "").replaceAll("_", " "),
  description: name.replaceAll("_", " "), projection, toolName: name,
});

/** Process-wide immutable source catalog. Runtime availability belongs to a session. */
export const capabilityRegistry = new CapabilityRegistry([
  ...groups,
  ...common.map((name) => tool(name, name.startsWith("document.") ? "document" : name.startsWith("workspace.") ? "workspace" : "agent", "always")),
  ...Object.entries(dynamic).flatMap(([parent, names]) => names.map((name) => tool(`document.${name}`, parent, "dynamic"))),
]);
