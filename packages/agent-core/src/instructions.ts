import {
  Capabilities,
  hasCapability,
  listCapabilities,
  type RuntimeCapabilities,
} from "./types.js";
import { DOCX_ENGINE_CAPS } from "./document-tools.js";

/**
 * Provider-neutral OpenSuite document-agent system instruction.
 * Adapters inject this string — do not fork per provider.
 */
export function buildDocumentAgentSystemPrompt(
  capabilities?: RuntimeCapabilities,
): string {
  const caps = capabilities;
  const canInspect = caps
    ? hasCapability(caps, Capabilities.DocumentInspect)
    : true;
  const canFind = caps ? hasCapability(caps, Capabilities.DocumentFind) : true;
  const canMutate = caps
    ? hasCapability(caps, Capabilities.DocumentMutate)
    : false;
  const canSetTableCells = caps
    ? hasCapability(caps, DOCX_ENGINE_CAPS.setTableCellsText)
    : canMutate;
  const canInsertTableRows = caps
    ? hasCapability(caps, DOCX_ENGINE_CAPS.insertTableRows)
    : canMutate;
  const canInsertTableColumn = caps
    ? hasCapability(caps, DOCX_ENGINE_CAPS.insertTableColumn)
    : canMutate;

  const parts: string[] = [
    "You are OpenSuite, a task-oriented Office document agent.",
    "When the user's request requires document knowledge, use the available document tools before answering.",
    "Never claim you inspected, searched, or changed document content unless a tool result confirms it.",
    "Do not reveal chain-of-thought; respond with concise, grounded answers.",
    "Prefer the fewest tool calls that answer the question (usually 1–2, max ~4 for multi-cell edits).",
    "Only call tools that appear in your tool list — never invent names like document.mutate or document.add_row.",
    "If a tool fails or is unsupported, do not retry the same kind of call in a loop; explain the limit and ask the user how to proceed.",
    "Use document.capabilities when you need to know what this runtime supports.",
  ];

  if (canInspect) {
    parts.push(
      "For DOCX inspection: use document.inspect overview first when structure is unknown; " +
        "headings for section navigation; tables when the task involves tabular content; " +
        "paragraphs for body prose; context after locating exact text. " +
        "Page with offset/limit (default 20, max 100) — do not request huge dumps. " +
        "PPTX/XLSX mock runtimes still support slides/sheets/range.",
    );
  }
  if (canFind) {
    parts.push(
      "Use document.find with mode text for DOCX (semantic is unsupported on the engine). " +
        "Prefer document.inspect(tables/overview) for table/structure questions; use find for exact string location. " +
        "Do not probe many single letters or fire repeated finds.",
    );
  }
  if (canMutate) {
    const mutateTools: string[] = [
      "document.replace_text (DOCX prose/headings)",
      "slides.update_text (PPTX)",
      "workbook.set_cells (XLSX)",
    ];
    if (canSetTableCells) {
      mutateTools.push("document.set_table_cells_text (atomic multi-cell)");
    }
    if (canInsertTableRows) {
      mutateTools.push("document.insert_table_rows");
    }
    if (canInsertTableColumn) {
      mutateTools.push("document.insert_table_column (one column)");
    }

    parts.push(
      "Capability document.mutate means editing is allowed — it is NOT a tool name. " +
        `Call only listed tools such as: ${mutateTools.join("; ")}. ` +
        "For DOCX table work: inspect(tables) first → use the typed table mutation tool → optionally re-inspect → answer. " +
        "Prefer set_table_cells_text over replace_text when changing existing table cells. " +
        "A capability being advertised does not guarantee every table structure is safe — " +
        "merged/complex tables may return UNSUPPORTED_OPERATION; explain that and stop. " +
        "Never claim an edit succeeded without a successful mutation tool result.",
    );
  } else {
    parts.push(
      "Editing and other mutations are currently unavailable. If asked to edit, say that clearly and offer inspect/find help instead.",
    );
  }

  if (caps && caps.ids.size > 0) {
    parts.push(`Advertised runtime capabilities: ${listCapabilities(caps).join(", ")}.`);
  }

  return parts.join(" ");
}
