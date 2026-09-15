import type {
  DocxEngineBinding,
  DocxExtendedOperationName,
  DocxMutationBindingResult,
} from "./docx-engine-binding.js";

/** Direct typed binding methods (args shaped by engine-client). */
const DIRECT: Record<string, keyof DocxEngineBinding> = {
  replace_text: "executeDocxReplaceText",
  insert_paragraph: "executeDocxInsertParagraph",
  insert_paragraphs: "executeDocxInsertParagraphs",
  delete_paragraph: "executeDocxDeleteParagraph",
  set_paragraph_style: "executeDocxSetParagraphStyle",
  set_paragraph_formatting: "executeDocxSetParagraphFormatting",
  set_text_formatting: "executeDocxSetTextFormatting",
  set_table_cells_text: "executeDocxSetTableCellsText",
  insert_table_rows: "executeDocxInsertTableRows",
  insert_table_column: "executeDocxInsertTableColumn",
  create_table: "executeDocxCreateTable",
  delete_table: "executeDocxDeleteTable",
  delete_table_row: "executeDocxDeleteTableRow",
  delete_table_column: "executeDocxDeleteTableColumn",
  set_table_formatting: "executeDocxSetTableFormatting",
  set_table_column_widths: "executeDocxSetTableColumnWidths",
  set_table_cell_shading: "executeDocxSetTableCellShading",
};

/**
 * Extended N-API methods. Includes binary picture ops that are dispatchable
 * programmatically but must NOT be model-exposed (JSON cannot carry Buffer).
 */
const EXTENDED: Record<string, DocxExtendedOperationName> = {
  set_content_control_text: "executeDocxSetContentControlText",
  set_paragraphs_list: "executeDocxSetParagraphsList",
  set_hyperlink: "executeDocxSetHyperlink",
  insert_picture: "executeDocxInsertPicture",
  delete_picture: "executeDocxDeletePicture",
  set_picture_size: "executeDocxSetPictureSize",
  replace_picture: "executeDocxReplacePicture",
  insert_page_break: "executeDocxInsertPageBreak",
  delete_page_break: "executeDocxDeletePageBreak",
  set_page_setup: "executeDocxSetPageSetup",
  set_header_footer_text: "executeDocxSetHeaderFooterText",
  set_page_number: "executeDocxSetPageNumber",
  insert_table_row: "executeDocxInsertTableRow",
};

/** Every capability the bound host can dispatch (model + programmatic). */
export const DISPATCHABLE_MUTATION_CAPABILITIES = Object.freeze(
  [...Object.keys(DIRECT), ...Object.keys(EXTENDED)].sort(),
);

export type DispatchableMutationCapability =
  (typeof DISPATCHABLE_MUTATION_CAPABILITIES)[number];

export async function dispatchMutation(
  binding: DocxEngineBinding,
  bytes: Uint8Array,
  capability: string,
  operation: Record<string, unknown>,
): Promise<DocxMutationBindingResult> {
  const direct = DIRECT[capability];
  if (direct) {
    const method = binding[direct];
    if (typeof method !== "function") {
      throw new Error(`${capability} is not available on this binding`);
    }
    return (
      method as (
        input: Uint8Array,
        operation: never,
      ) => Promise<DocxMutationBindingResult>
    ).call(binding, bytes, operation as never);
  }

  const extended = EXTENDED[capability];
  if (!extended || !binding.executeDocxExtended) {
    throw new Error(`Unsupported mutation capability: ${capability}`);
  }
  return binding.executeDocxExtended(bytes, extended, operation);
}
