import type {
  DocxEngineBinding,
  DocxEngineDiagnostic,
  DocxEngineOperationResult,
  DocxExtendedOperationName,
  DocxFindTextRequest,
  DocxFindTextResult,
  DocxInspectRequest,
  DocxInspectResult,
  DocxMutationBindingResult,
  DocxRuntimeCapabilities,
} from "./docx-engine-binding.js";

export interface BoundDocxPersistInput {
  readonly bytes: Uint8Array;
  readonly baseVersionId: string;
}

export interface BoundDocxPersistResult {
  readonly versionId: string;
  readonly versionNumber?: number;
}

export interface BoundDocxMutationResult {
  readonly ok: boolean;
  readonly capability: string;
  readonly status: string;
  readonly reasonCode?: string;
  readonly diagnostics: readonly DocxEngineDiagnostic[];
  readonly changes?: DocxEngineOperationResult["changes"];
  /** Present only after successful persist (or in-memory advance when no persist). */
  readonly versionId?: string;
  readonly versionNumber?: number;
}

/**
 * Server-bound DOCX document: evolving bytes + engine binding.
 * Tools call this; the model never chooses document/version IDs.
 *
 * Writes run through Rust, then an application persist callback advances
 * the immutable version. Sibling writes see updated bytes sequentially.
 */
export function bindDocxDocument(input: {
  readonly binding: DocxEngineBinding;
  readonly bytes: Uint8Array;
  readonly versionId?: string;
  readonly persist?: (
    next: BoundDocxPersistInput,
  ) => Promise<BoundDocxPersistResult>;
}) {
  const { binding, persist } = input;
  let bytes = input.bytes;
  let versionId = input.versionId;

  return {
    capabilities(): DocxRuntimeCapabilities {
      return binding.getDocxCapabilities();
    },
    inspect(request: DocxInspectRequest): Promise<DocxInspectResult> {
      return binding.inspectDocx(bytes, request);
    },
    find(request: DocxFindTextRequest): Promise<DocxFindTextResult> {
      return binding.findDocxText(bytes, request);
    },
    currentVersionId(): string | undefined {
      return versionId;
    },
    async mutate(
      capability: string,
      operation: Record<string, unknown>,
    ): Promise<BoundDocxMutationResult> {
      let engine: DocxMutationBindingResult;
      try {
        engine = await dispatchMutation(binding, bytes, capability, operation);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Mutation dispatch failed";
        return {
          ok: false,
          capability,
          status: "error",
          reasonCode: "DISPATCH_FAILED",
          diagnostics: [
            {
              code: "DISPATCH_FAILED",
              severity: "error",
              message,
              reasonCode: "DISPATCH_FAILED",
              operation: capability,
            },
          ],
        };
      }

      if (!engine.result.ok || !engine.output || engine.output.byteLength === 0) {
        return compactEngineFailure(capability, engine.result);
      }

      if (persist) {
        if (!versionId) {
          return {
            ok: false,
            capability,
            status: "error",
            reasonCode: "MISSING_BASE_VERSION",
            diagnostics: [
              {
                code: "MISSING_BASE_VERSION",
                severity: "error",
                message: "Bound document has no versionId for persistence",
                reasonCode: "MISSING_BASE_VERSION",
                operation: capability,
              },
            ],
          };
        }
        try {
          const saved = await persist({
            bytes: engine.output,
            baseVersionId: versionId,
          });
          bytes = engine.output;
          versionId = saved.versionId;
          return {
            ok: true,
            capability,
            status: engine.result.status,
            diagnostics: engine.result.diagnostics,
            changes: engine.result.changes,
            versionId: saved.versionId,
            ...(saved.versionNumber !== undefined
              ? { versionNumber: saved.versionNumber }
              : {}),
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Persistence failed";
          return {
            ok: false,
            capability,
            status: "error",
            reasonCode: "PERSISTENCE_FAILED",
            diagnostics: [
              {
                code: "PERSISTENCE_FAILED",
                severity: "error",
                message,
                reasonCode: "PERSISTENCE_FAILED",
                operation: capability,
              },
            ],
          };
        }
      }

      // No persist callback (tests): advance in-memory bytes only.
      bytes = engine.output;
      return {
        ok: true,
        capability,
        status: engine.result.status,
        diagnostics: engine.result.diagnostics,
        changes: engine.result.changes,
        ...(versionId !== undefined ? { versionId } : {}),
      };
    },
  };
}

export type BoundDocxDocument = ReturnType<typeof bindDocxDocument>;

function compactEngineFailure(
  capability: string,
  result: DocxEngineOperationResult,
): BoundDocxMutationResult {
  const reasonCode =
    result.diagnostics.find((d) => d.reasonCode)?.reasonCode ??
    result.diagnostics[0]?.code;
  return {
    ok: false,
    capability,
    status: result.status,
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    diagnostics: result.diagnostics,
    changes: result.changes,
  };
}

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

async function dispatchMutation(
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
