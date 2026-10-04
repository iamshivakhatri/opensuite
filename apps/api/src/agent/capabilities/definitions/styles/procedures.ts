import type { CapabilityDefinition } from "../../core/registry.js";

export const procedureStyles: CapabilityDefinition[] = [{
  id: "styles.procedures.controlled-sop", parentId: "styles.procedures", kind: "instruction",
  title: "Controlled SOP Style", description: "Consistent, readable process-document appearance",
  aliases: ["SOP process procedure controlled style"], projection: "dynamic",
  companionCapabilities: ["document.paragraphs", "document.text", "document.tables.styling", "document.layout"],
  instructions: () => `Style a process document for clear step-by-step use.
- In a new blank document, use the guaranteed Title, Heading 1, Heading 2, and Normal paragraph styles. Do not invent procedure-specific paragraph styles.
- Use a compact metadata table only when supplied fields make it useful.
- Format procedure steps with document.set_paragraphs_list using kind \"decimal\", and use paragraph formatting for compact spacing.
- Distinguish supplied warnings or notes with document.set_text_formatting for restrained bold or text color.
- Use table formatting tools for metadata-table borders, widths, or header fill. Use layout tools for a simple header, footer, or page number only when appropriate and available.
- Preserve an existing SOP's formatting during narrow updates unless redesign is requested.`,
}];
