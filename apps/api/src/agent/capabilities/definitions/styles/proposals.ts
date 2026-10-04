import type { CapabilityDefinition } from "../../core/registry.js";

export const proposalStyles: CapabilityDefinition[] = [{
  id: "styles.proposals.professional", parentId: "styles.proposals", kind: "instruction",
  title: "Professional Proposal Style", description: "Clear business-proposal appearance with simple headings and tables",
  aliases: ["project proposal business proposal style"], projection: "dynamic",
  companionCapabilities: ["document.tables.styling", "document.text", "document.paragraphs", "document.layout"],
  instructions: () => `Style a business proposal for quick reading.
- In a new blank document, use the guaranteed Title, Heading 1, Heading 2, and Normal paragraph styles. Do not name a paragraph style that has not been confirmed in an existing document.
- Keep paragraphs readable with document.set_paragraph_formatting for balanced spacing and document.set_text_formatting for restrained emphasis.
- Use simple tables for supplied scope, deliverables, or pricing when a table improves comparison.
- Apply borders with document.set_table_formatting, widths with document.set_table_column_widths, and light header fill or bold text with table-cell or text formatting tools.
- Keep page setup conventional through document.set_page_setup when available; follow the user's template or visual requirements.`,
}];
