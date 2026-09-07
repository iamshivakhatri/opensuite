/** Stable document tool names advertised to the model. */
export const DOCUMENT_TOOL_NAMES = {
  capabilities: "document.capabilities",
  inspect: "document.inspect",
  find: "document.find",
  replaceText: "document.replace_text",
  insertParagraph: "document.insert_paragraph",
  insertParagraphs: "document.insert_paragraphs",
  deleteParagraph: "document.delete_paragraph",
  setParagraphStyle: "document.set_paragraph_style",
  setParagraphFormatting: "document.set_paragraph_formatting",
  setTextFormatting: "document.set_text_formatting",
  setTableCellsText: "document.set_table_cells_text",
  insertTableRows: "document.insert_table_rows",
  insertTableColumn: "document.insert_table_column",
  createTable: "document.create_table",
  deleteTable: "document.delete_table",
  deleteTableRow: "document.delete_table_row",
  deleteTableColumn: "document.delete_table_column",
  updateSlideText: "slides.update_text",
  setCells: "workbook.set_cells",
} as const;

/** Rust-advertised DOCX mutation capability ids (also mirrored in RuntimeCapabilities). */
export const DOCX_ENGINE_CAPS = {
  replaceText: "replace_text",
  insertParagraph: "insert_paragraph",
  insertParagraphs: "insert_paragraphs",
  deleteParagraph: "delete_paragraph",
  setParagraphStyle: "set_paragraph_style",
  setParagraphFormatting: "set_paragraph_formatting",
  setTextFormatting: "set_text_formatting",
  setTableCellsText: "set_table_cells_text",
  insertTableRows: "insert_table_rows",
  insertTableColumn: "insert_table_column",
  createTable: "create_table",
  deleteTable: "delete_table",
  deleteTableRow: "delete_table_row",
  deleteTableColumn: "delete_table_column",
} as const;

/**
 * Mock PPTX/XLSX mutation capability ids.
 * Advertised by format-specific mock runtimes — not format-hardcoded in the registry.
 */
export const MOCK_FORMAT_CAPS = {
  updateSlideText: "slides.update_text",
  setCells: "workbook.set_cells",
} as const;
