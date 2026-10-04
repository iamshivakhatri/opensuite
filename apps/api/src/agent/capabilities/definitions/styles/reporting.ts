import type { CapabilityDefinition } from "../../core/registry.js";

export const reportingStyles: CapabilityDefinition[] = [{
  id: "styles.reporting.professional", parentId: "styles.reporting", kind: "instruction",
  title: "Professional Report Style", description: "Readable business-report appearance using supported DOCX formatting",
  aliases: ["monthly operating report figures", "professional reporting style"], projection: "dynamic",
  companionCapabilities: ["document.tables.styling", "document.text", "document.paragraphs", "document.layout"],
  instructions: () => `Style a new or substantially reworked business report with available document tools.
- In a new blank document, use the guaranteed Title, Heading 1, Heading 2, and Normal paragraph styles. For an existing document, use only styles known to exist; use direct formatting for everything else.
- Keep body text readable and left aligned. Use document.set_paragraph_formatting for consistent spacing and document.set_text_formatting for restrained bold emphasis.
- For KPI or data tables, use document.set_table_cells_formatting to bold header text and apply a restrained header fill, or use document.set_table_cell_shading plus text formatting. Use document.set_table_formatting for sensible borders and document.set_table_column_widths for widths.
- Use ordinary business-report margins only through document.set_page_setup when that capability is available.
- For a longer report, a simple footer or page number may help when supported.
- Keep visual density moderate; follow any user template or explicit formatting request instead.`,
}];
