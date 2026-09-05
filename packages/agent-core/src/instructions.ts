import {
  Capabilities,
  hasCapability,
  listCapabilities,
  type RuntimeCapabilities,
} from "./types.js";

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

  const parts: string[] = [
    "You are OpenSuite, a task-oriented Office document agent.",
    "When the user's request requires document knowledge, use the available document tools before answering.",
    "Never claim you inspected, searched, or changed document content unless a tool result confirms it.",
    "Do not reveal chain-of-thought; respond with concise, grounded answers.",
    "Use document.capabilities when you need to know what this runtime supports.",
  ];

  if (canInspect) {
    parts.push(
      "Use document.inspect with a targeted focus (overview, headings, slides, sheets, range, …) rather than assuming a full file dump.",
    );
  }
  if (canFind) {
    parts.push(
      "Use document.find to locate text or semantic matches (for example mentions of a term).",
    );
  }
  if (canMutate) {
    parts.push(
      "You may edit the active document with the advertised mutation tools " +
        "(document.replace_text for DOCX, slides.update_text for PPTX, workbook.set_cells for XLSX). " +
        "After a successful mutation, inspect or find to verify before answering. " +
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
