import type { AgentTool, ToolInputSchema } from "../model.js";
import type { PersistedDocumentMutationToolResult } from "../document-mutation.js";
import { assertObject, defineDocumentTool, executePersistedMutation, invalidInput } from "./define-tool.js";
import { DOCUMENT_TOOL_NAMES, DOCX_ENGINE_CAPS } from "./names.js";
import { parseOptionalOccurrence } from "./shared-schema.js";
import {
  parseParagraphPlacement,
  parseRowAnchor,
  parseTableTarget,
  parseTextTarget,
} from "./selectors.js";

type ExtendedInput = Record<string, unknown>;

function tool(name: string, capability: string, description: string, inputSchema: ToolInputSchema, parseInput = (raw: unknown) => requiredInput(raw, name)): AgentTool<ExtendedInput, PersistedDocumentMutationToolResult> {
  return defineDocumentTool({
    name,
    description,
    effect: "write",
    executionMode: "sequential",
    capability,
    inputSchema,
    parseInput(raw) {
      const value = parseInput(raw);
      const requiredFields = inputSchema.required;
      for (const required of Array.isArray(requiredFields) ? requiredFields : []) {
        if (typeof required === "string" && value[required] === undefined) {
          invalidInput(`${name} requires ${required}`);
        }
      }
      return value;
    },
    execute: (input, ctx) => executePersistedMutation(
      ctx,
      name,
      (document, mutations) => {
        if (!mutations.mutate) throw new Error("Document mutation executor does not support this DOCX operation");
        return mutations.mutate({ document, type: name, payload: input, signal: ctx.signal, runId: ctx.runId });
      },
      input,
    ),
  });
}

function requiredInput(raw: unknown, name: string): ExtendedInput {
  const value = assertObject(raw, name);
  return value;
}

function parseContentControlTarget(raw: unknown): ExtendedInput {
  const target = assertObject(raw, DOCUMENT_TOOL_NAMES.setContentControlText);
  const tag = typeof target.tag === "string" && target.tag ? target.tag : undefined;
  const alias = typeof target.alias === "string" && target.alias ? target.alias : undefined;
  if (!tag && !alias) invalidInput("document.set_content_control_text target requires tag or alias");
  const occurrence = parseOptionalOccurrence(target.occurrence, "document.set_content_control_text target.occurrence");
  return { ...(tag !== undefined ? { tag } : {}), ...(alias !== undefined ? { alias } : {}), ...(occurrence !== undefined ? { occurrence } : {}) };
}

function parseInsertTableRow(raw: unknown): ExtendedInput {
  const value = assertObject(raw, DOCUMENT_TOOL_NAMES.insertTableRow);
  if (!Array.isArray(value.cells) || value.cells.some((cell) => typeof cell !== "string")) invalidInput("document.insert_table_row cells must be an array of strings");
  return {
    table: parseTableTarget(value.table, DOCUMENT_TOOL_NAMES.insertTableRow),
    after: parseRowAnchor(assertObject(value.after, DOCUMENT_TOOL_NAMES.insertTableRow), DOCUMENT_TOOL_NAMES.insertTableRow),
    cells: value.cells,
  };
}

function parseParagraphsList(raw: unknown): ExtendedInput {
  const value = assertObject(raw, DOCUMENT_TOOL_NAMES.setParagraphsList);
  if (!Array.isArray(value.targets) || value.targets.length === 0) invalidInput("document.set_paragraphs_list requires non-empty targets");
  if (value.level !== undefined && value.level !== 0 && value.level !== 1 && value.level !== 2) invalidInput("document.set_paragraphs_list level must be 0, 1, or 2");
  if (value.continueFromPrevious !== undefined && typeof value.continueFromPrevious !== "boolean") invalidInput("document.set_paragraphs_list continueFromPrevious must be a boolean");
  return {
    targets: value.targets.map((target) => parseTextTarget(target, DOCUMENT_TOOL_NAMES.setParagraphsList)),
    kind: value.kind,
    ...(value.level !== undefined ? { level: value.level } : {}),
    ...(typeof value.continueFromPrevious === "boolean" ? { continueFromPrevious: value.continueFromPrevious } : {}),
  };
}

function parseHyperlink(raw: unknown): ExtendedInput {
  const value = assertObject(raw, DOCUMENT_TOOL_NAMES.setHyperlink);
  if (value.url !== undefined && typeof value.url !== "string") invalidInput("document.set_hyperlink url must be a string");
  return { target: parseTextTarget(value.target, DOCUMENT_TOOL_NAMES.setHyperlink), ...(typeof value.url === "string" ? { url: value.url } : {}) };
}

function parsePicture(raw: unknown): ExtendedInput {
  const value = requiredInput(raw, DOCUMENT_TOOL_NAMES.insertPicture);
  return { ...value, placement: parseParagraphPlacement(value.placement, DOCUMENT_TOOL_NAMES.insertPicture) };
}

function parsePageBreak(raw: unknown): ExtendedInput {
  const value = requiredInput(raw, DOCUMENT_TOOL_NAMES.insertPageBreak);
  return { ...value, placement: parseParagraphPlacement(value.placement, DOCUMENT_TOOL_NAMES.insertPageBreak) };
}

const placement = { type: "object", properties: { kind: { type: "string", enum: ["start", "end", "before", "after"] }, handle: { type: "string" } }, required: ["kind"], additionalProperties: false } as const;
const target = { type: "object", properties: { text: { type: "string" }, occurrence: { type: "number" } }, required: ["text"], additionalProperties: false } as const;
const handle = { type: "string", description: "Opaque handle from the latest inspection; stale after a write" } as const;

export const createDocumentSetContentControlTextTool = () => tool(DOCUMENT_TOOL_NAMES.setContentControlText, DOCX_ENGINE_CAPS.setContentControlText, "Replace text in a content control selected by its visible tag or alias.", { type: "object", properties: { target: { type: "object", properties: { tag: { type: "string" }, alias: { type: "string" }, occurrence: { type: "number" } }, additionalProperties: false }, expectedCurrentText: { type: "string" }, replacement: { type: "string" } }, required: ["target", "expectedCurrentText", "replacement"], additionalProperties: false }, (raw) => ({ ...requiredInput(raw, DOCUMENT_TOOL_NAMES.setContentControlText), target: parseContentControlTarget(assertObject(raw, DOCUMENT_TOOL_NAMES.setContentControlText).target) }));
export const createDocumentInsertTableRowTool = () => tool(DOCUMENT_TOOL_NAMES.insertTableRow, DOCX_ENGINE_CAPS.insertTableRow, "Insert one table row after a semantic or opaque row target.", { type: "object", properties: { table: { type: "object" }, after: { type: "object" }, cells: { type: "array", items: { type: "string" } } }, required: ["table", "after", "cells"], additionalProperties: false }, parseInsertTableRow);
export const createDocumentSetParagraphsListTool = () => tool(DOCUMENT_TOOL_NAMES.setParagraphsList, DOCX_ENGINE_CAPS.setParagraphsList, "Set/clear bullet or decimal list (levels 0–2) only for genuine itemization, enumeration, or steps — not to group related short lines, quotations, metadata, or compact prose.", { type: "object", properties: { targets: { type: "array", items: target }, kind: { type: "string", enum: ["bullet", "decimal", "none"] }, level: { type: "number", enum: [0, 1, 2] }, continueFromPrevious: { type: "boolean" } }, required: ["targets", "kind"], additionalProperties: false }, parseParagraphsList);
export const createDocumentSetHyperlinkTool = () => tool(DOCUMENT_TOOL_NAMES.setHyperlink, DOCX_ENGINE_CAPS.setHyperlink, "Set or clear the external hyperlink on exact visible text.", { type: "object", properties: { target, url: { type: "string", description: "Omit to clear" } }, required: ["target"], additionalProperties: false }, parseHyperlink);
export const createDocumentInsertPictureTool = () => tool(DOCUMENT_TOOL_NAMES.insertPicture, DOCX_ENGINE_CAPS.insertPicture, "Insert image bytes at a body location. imageBytes are 0–255 byte values supplied by the application.", { type: "object", properties: { imageBytes: { type: "array", items: { type: "number" } }, placement, altText: { type: "string" } }, required: ["imageBytes", "placement"], additionalProperties: false }, parsePicture);
export const createDocumentDeletePictureTool = () => tool(DOCUMENT_TOOL_NAMES.deletePicture, DOCX_ENGINE_CAPS.deletePicture, "Delete a picture selected by an opaque handle from the latest body-block inspection.", { type: "object", properties: { handle }, required: ["handle"], additionalProperties: false });
export const createDocumentSetPictureSizeTool = () => tool(DOCUMENT_TOOL_NAMES.setPictureSize, DOCX_ENGINE_CAPS.setPictureSize, "Resize a picture by exactly one EMU dimension.", { type: "object", properties: { handle, widthEmu: { type: "number" }, heightEmu: { type: "number" } }, required: ["handle"], additionalProperties: false });
export const createDocumentReplacePictureTool = () => tool(DOCUMENT_TOOL_NAMES.replacePicture, DOCX_ENGINE_CAPS.replacePicture, "Replace a picture using image bytes supplied by the application.", { type: "object", properties: { handle, replacementBytes: { type: "array", items: { type: "number" } }, contentType: { type: "string" } }, required: ["handle", "replacementBytes", "contentType"], additionalProperties: false });
export const createDocumentInsertPageBreakTool = () => tool(DOCUMENT_TOOL_NAMES.insertPageBreak, DOCX_ENGINE_CAPS.insertPageBreak, "Insert a page break when a hard section split is needed.", { type: "object", properties: { placement }, required: ["placement"], additionalProperties: false }, parsePageBreak);
export const createDocumentDeletePageBreakTool = () => tool(DOCUMENT_TOOL_NAMES.deletePageBreak, DOCX_ENGINE_CAPS.deletePageBreak, "Delete a page break using its opaque handle from the latest inspection.", { type: "object", properties: { handle }, required: ["handle"], additionalProperties: false });
export const createDocumentSetPageSetupTool = () => tool(DOCUMENT_TOOL_NAMES.setPageSetup, DOCX_ENGINE_CAPS.setPageSetup, "Set page margins, paper size, or orientation when geometry matters.", { type: "object", properties: { topMarginTwips: { type: "number" }, rightMarginTwips: { type: "number" }, bottomMarginTwips: { type: "number" }, leftMarginTwips: { type: "number" }, paperSize: { type: "string", enum: ["letter", "a4"] }, orientation: { type: "string", enum: ["portrait", "landscape"] } }, additionalProperties: false });
export const createDocumentSetHeaderFooterTextTool = () => tool(DOCUMENT_TOOL_NAMES.setHeaderFooterText, DOCX_ENGINE_CAPS.setHeaderFooterText, "Set or clear header/footer text for document-level metadata.", { type: "object", properties: { kind: { type: "string", enum: ["header", "footer"] }, text: { type: "string", description: "Omit to clear" } }, required: ["kind"], additionalProperties: false });
export const createDocumentSetPageNumberTool = () => tool(DOCUMENT_TOOL_NAMES.setPageNumber, DOCX_ENGINE_CAPS.setPageNumber, "Add, align, or remove a header/footer page number.", { type: "object", properties: { kind: { type: "string", enum: ["header", "footer"] }, alignment: { type: "string", enum: ["left", "center", "right"], description: "Omit to remove" } }, required: ["kind"], additionalProperties: false });
