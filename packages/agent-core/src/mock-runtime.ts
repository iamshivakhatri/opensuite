import { AgentCoreError } from "./errors.js";
import type {
  DocumentInspectFocus,
  DocumentOperation,
  DocumentRuntime,
  FindMatch,
  InspectionPayload,
  OperationResult,
} from "./runtime.js";
import {
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
} from "./runtime.js";
import {
  Capabilities,
  createCapabilities,
  hasCapability,
  type DocumentRef,
  type RuntimeCapabilities,
  type SemanticTarget,
} from "./types.js";

/**
 * Deterministic in-memory DocumentRuntime for DOCX/PPTX/XLSX.
 * Does not parse Office binaries — fixture semantics only.
 * Mutable runs keep deep-cloned working copies keyed by runId.
 */

export const MOCK_DOCUMENT_CAPABILITIES: RuntimeCapabilities = createCapabilities(
  Capabilities.DocumentInspect,
  Capabilities.DocumentFind,
);

export const MOCK_MUTABLE_DOCUMENT_CAPABILITIES: RuntimeCapabilities =
  createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    "replace_text",
    "set_table_cells_text",
    "insert_table_rows",
    "insert_table_column",
  );

interface DocxFixture {
  readonly title: string;
  readonly headings: readonly { level: number; text: string; handle: string }[];
  readonly paragraphs: readonly { text: string; handle: string }[];
  readonly tables: readonly {
    handle: string;
    rows: number;
    cols: number;
    preview: readonly (readonly string[])[];
  }[];
}

interface PptxFixture {
  readonly title: string;
  readonly slides: readonly {
    index: number;
    title: string | null;
    text: readonly string[];
    handle: string;
  }[];
}

interface XlsxFixture {
  readonly title: string;
  readonly sheets: readonly {
    name: string;
    handle: string;
    rowCount: number;
    colCount: number;
  }[];
  readonly cells: readonly {
    sheet: string;
    address: string;
    value: string | number | null;
    handle: string;
  }[];
}

/** Mutable deep-clone shape used as the per-run working copy. */
interface WorkingDocx {
  title: string;
  headings: { level: number; text: string; handle: string }[];
  paragraphs: { text: string; handle: string }[];
  tables: {
    handle: string;
    rows: number;
    cols: number;
    preview: string[][];
  }[];
}

interface WorkingPptx {
  title: string;
  slides: {
    index: number;
    title: string | null;
    text: string[];
    handle: string;
  }[];
}

interface WorkingXlsx {
  title: string;
  sheets: {
    name: string;
    handle: string;
    rowCount: number;
    colCount: number;
  }[];
  cells: {
    sheet: string;
    address: string;
    value: string | number | null;
    handle: string;
  }[];
}

interface WorkingStore {
  docx: WorkingDocx;
  pptx: WorkingPptx;
  xlsx: WorkingXlsx;
}

const DOCX_BASE: DocxFixture = {
  title: "Annual Report 2025",
  headings: [
    { level: 1, text: "Introduction", handle: "docx:h:intro" },
    { level: 1, text: "Financial Overview", handle: "docx:h:finance" },
    { level: 2, text: "Revenue Analysis", handle: "docx:h:revenue" },
    { level: 1, text: "Outlook", handle: "docx:h:outlook" },
  ],
  paragraphs: [
    {
      handle: "docx:p:1",
      text: "This annual report summarizes company performance for fiscal year 2025.",
    },
    {
      handle: "docx:p:2",
      text: "Total revenue grew 12% year over year, led by subscription products.",
    },
    {
      handle: "docx:p:3",
      text: "Operating margins improved as recurring revenue expanded.",
    },
    {
      handle: "docx:p:4",
      text: "Management expects continued revenue momentum into the next quarter.",
    },
  ],
  tables: [
    {
      handle: "docx:t:1",
      rows: 3,
      cols: 3,
      preview: [
        ["Metric", "2024", "2025"],
        ["Revenue", "$40M", "$44.8M"],
        ["Customers", "1200", "1450"],
      ],
    },
  ],
};

const PPTX_BASE: PptxFixture = {
  title: "Q4 Business Review",
  slides: [
    {
      index: 0,
      title: "Agenda",
      text: ["Highlights", "Revenue", "Risks", "Next steps"],
      handle: "pptx:s:0",
    },
    {
      index: 1,
      title: "Revenue Highlights",
      text: [
        "Q4 revenue reached $12.1M",
        "Enterprise deals drove 40% of new revenue",
      ],
      handle: "pptx:s:1",
    },
    {
      index: 2,
      title: "Risks",
      text: ["Churn in SMB segment", "Hiring lag in GTM"],
      handle: "pptx:s:2",
    },
  ],
};

const XLSX_BASE: XlsxFixture = {
  title: "FY2025 Budget",
  sheets: [
    { name: "Summary", handle: "xlsx:sh:Summary", rowCount: 8, colCount: 4 },
    { name: "Revenue", handle: "xlsx:sh:Revenue", rowCount: 20, colCount: 6 },
    { name: "Expenses", handle: "xlsx:sh:Expenses", rowCount: 15, colCount: 5 },
  ],
  cells: [
    { sheet: "Summary", address: "A1", value: "Metric", handle: "xlsx:c:Summary!A1" },
    { sheet: "Summary", address: "B1", value: "Value", handle: "xlsx:c:Summary!B1" },
    {
      sheet: "Summary",
      address: "A2",
      value: "Total revenue",
      handle: "xlsx:c:Summary!A2",
    },
    { sheet: "Summary", address: "B2", value: 44_800_000, handle: "xlsx:c:Summary!B2" },
    {
      sheet: "Revenue",
      address: "A1",
      value: "Product",
      handle: "xlsx:c:Revenue!A1",
    },
    {
      sheet: "Revenue",
      address: "B1",
      value: "Revenue",
      handle: "xlsx:c:Revenue!B1",
    },
    {
      sheet: "Revenue",
      address: "A2",
      value: "Subscriptions",
      handle: "xlsx:c:Revenue!A2",
    },
    {
      sheet: "Revenue",
      address: "B2",
      value: 32_000_000,
      handle: "xlsx:c:Revenue!B2",
    },
    {
      sheet: "Expenses",
      address: "A1",
      value: "Category",
      handle: "xlsx:c:Expenses!A1",
    },
    {
      sheet: "Expenses",
      address: "B1",
      value: "Amount",
      handle: "xlsx:c:Expenses!B1",
    },
  ],
};

const DEFAULT_RUN_ID = "__default__";

export interface MockDocumentRuntimeOptions {
  /** Override advertised capabilities (default: inspect + find). */
  readonly capabilities?: RuntimeCapabilities;
}

export function createMockDocumentRuntime(
  options: MockDocumentRuntimeOptions = {},
): DocumentRuntime {
  const capabilities = options.capabilities ?? MOCK_DOCUMENT_CAPABILITIES;
  const stores = new Map<string, WorkingStore>();

  function storeFor(runId: string | undefined): WorkingStore {
    const key = runId ?? DEFAULT_RUN_ID;
    let store = stores.get(key);
    if (!store) {
      store = cloneWorkingStore();
      stores.set(key, store);
    }
    return store;
  }

  return {
    capabilities() {
      return capabilities;
    },

    async inspect(document, inspectOptions) {
      throwIfAborted(inspectOptions?.signal, "Inspect aborted");
      if (!hasCapability(capabilities, Capabilities.DocumentInspect)) {
        return unsupportedCapabilityResult(Capabilities.DocumentInspect);
      }

      const store = storeFor(inspectOptions?.runId);
      const focus = normalizeFocus(document, inspectOptions?.focus);
      const payload = buildInspectPayload(document, focus, store);
      if (!payload) {
        return {
          status: "error",
          diagnostics: [
            {
              code: "TARGET_NOT_FOUND",
              severity: "error",
              message: `Inspect focus target not found for ${document.format}`,
              details: { focus },
            },
          ],
        };
      }

      return {
        status: "success",
        format: document.format,
        capabilities,
        diagnostics: [],
        payload,
        focus,
      };
    },

    async find(document, query, findOptions) {
      throwIfAborted(findOptions?.signal, "Find aborted");
      if (!hasCapability(capabilities, Capabilities.DocumentFind)) {
        return unsupportedCapabilityFind(Capabilities.DocumentFind);
      }

      const trimmed = query.query.trim();
      if (!trimmed) {
        return {
          status: "error",
          diagnostics: [
            {
              code: "INVALID_FIND_QUERY",
              severity: "error",
              message: "Find query must be a non-empty string",
            },
          ],
        };
      }

      const store = storeFor(findOptions?.runId);
      const mode = query.mode ?? "semantic";
      const maxResults = clampMaxResults(query.maxResults);
      const matches = collectMatches(document, trimmed, mode, store).slice(
        0,
        maxResults,
      );

      return {
        status: "success",
        query: trimmed,
        mode,
        matches,
        diagnostics: [],
      };
    },

    async execute(document, operation, executeOptions) {
      throwIfAborted(executeOptions?.signal, "Execute aborted");
      if (!hasCapability(capabilities, Capabilities.DocumentMutate)) {
        return unsupportedCapabilityOperation(Capabilities.DocumentMutate);
      }

      const store = storeFor(executeOptions?.runId);
      return applyMutation(document, operation, store);
    },
  };
}

function cloneWorkingStore(): WorkingStore {
  return {
    docx: structuredClone(DOCX_BASE) as WorkingDocx,
    pptx: structuredClone(PPTX_BASE) as WorkingPptx,
    xlsx: structuredClone(XLSX_BASE) as WorkingXlsx,
  };
}

function throwIfAborted(signal: AbortSignal | undefined, message: string): void {
  if (signal?.aborted) {
    throw new AgentCoreError("CANCELLED", message);
  }
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function normalizeFocus(
  document: DocumentRef,
  focus: DocumentInspectFocus | undefined,
): DocumentInspectFocus {
  if (!focus) {
    return { kind: "overview" };
  }
  if (focus.kind === "structure") {
    if (document.format === "pptx") return { kind: "slides" };
    if (document.format === "xlsx") return { kind: "sheets" };
    return { kind: "headings" };
  }
  return focus;
}

function buildInspectPayload(
  document: DocumentRef,
  focus: DocumentInspectFocus,
  store: WorkingStore,
): InspectionPayload | null {
  if (document.format === "docx") {
    return buildDocxPayload(focus, store.docx);
  }
  if (document.format === "pptx") {
    return buildPptxPayload(focus, store.pptx);
  }
  return buildXlsxPayload(focus, store.xlsx);
}

function buildDocxPayload(
  focus: DocumentInspectFocus,
  docx: WorkingDocx,
): InspectionPayload | null {
  const summary = {
    title: docx.title,
    unitKind: "page" as const,
    unitCount: 4,
  };

  switch (focus.kind) {
    case "overview":
      return {
        format: "docx",
        summary,
        overview: {
          bodyBlockCount: docx.paragraphs.length + docx.tables.length,
          paragraphCount: docx.paragraphs.length,
          tableCount: docx.tables.length,
          sectionCount: 1,
        },
        headings: docx.headings.map((h) => ({
          level: h.level,
          text: h.text,
          handle: h.handle,
        })),
      };
    case "headings":
    case "structure": {
      const all = docx.headings.map((h) => ({
        level: h.level,
        text: h.text,
        handle: h.handle,
      }));
      const paged = pageItems(
        all,
        focus.kind === "headings" ? focus.offset : undefined,
        focus.kind === "headings" ? focus.limit : undefined,
      );
      return {
        format: "docx",
        summary,
        page: paged.page,
        headings: paged.items,
      };
    }
    case "paragraphs": {
      const all = docx.paragraphs.map((p) => ({
        text: p.text,
        handle: p.handle,
      }));
      const paged = pageItems(all, focus.offset, focus.limit);
      return {
        format: "docx",
        summary,
        page: paged.page,
        paragraphs: paged.items,
      };
    }
    case "tables": {
      const all = docx.tables.map((t) => ({
        handle: t.handle,
        rows: t.rows,
        cols: t.cols,
        preview: t.preview,
        cells: t.preview,
        isRectangular: true,
      }));
      const paged = pageItems(all, focus.offset, focus.limit);
      return {
        format: "docx",
        summary,
        page: paged.page,
        tables: paged.items,
      };
    }
    case "slides":
    case "slide":
    case "sheets":
    case "range":
    case "context":
      return null;
    default: {
      const _exhaustive: never = focus;
      void _exhaustive;
      return null;
    }
  }
}

function pageItems<T>(
  items: readonly T[],
  offset: number | undefined,
  limit: number | undefined,
): {
  readonly page: {
    readonly total: number;
    readonly offset: number;
    readonly returned: number;
    readonly hasMore: boolean;
  };
  readonly items: T[];
} {
  const resolvedOffset = offset ?? 0;
  const resolvedLimit = limit ?? 20;
  const sliced = items.slice(resolvedOffset, resolvedOffset + resolvedLimit);
  return {
    page: {
      total: items.length,
      offset: resolvedOffset,
      returned: sliced.length,
      hasMore: resolvedOffset + sliced.length < items.length,
    },
    items: sliced,
  };
}

function buildPptxPayload(
  focus: DocumentInspectFocus,
  pptx: WorkingPptx,
): InspectionPayload | null {
  const summary = {
    title: pptx.title,
    unitKind: "slide" as const,
    unitCount: pptx.slides.length,
  };

  switch (focus.kind) {
    case "overview":
    case "slides":
    case "structure":
      return {
        format: "pptx",
        summary,
        slides: pptx.slides.map((s) => ({
          handle: s.handle,
          index: s.index,
          title: s.title,
          text: s.text,
        })),
      };
    case "slide": {
      const slide = pptx.slides.find((s) => s.index === focus.index);
      if (!slide) return null;
      return {
        format: "pptx",
        summary,
        slides: [
          {
            handle: slide.handle,
            index: slide.index,
            title: slide.title,
            text: slide.text,
          },
        ],
      };
    }
    case "headings":
    case "paragraphs":
    case "tables":
    case "sheets":
    case "range":
    case "context":
      return null;
    default: {
      const _exhaustive: never = focus;
      void _exhaustive;
      return null;
    }
  }
}

function buildXlsxPayload(
  focus: DocumentInspectFocus,
  xlsx: WorkingXlsx,
): InspectionPayload | null {
  const summary = {
    title: xlsx.title,
    unitKind: "sheet" as const,
    unitCount: xlsx.sheets.length,
  };

  switch (focus.kind) {
    case "overview":
    case "sheets":
    case "structure":
      return {
        format: "xlsx",
        summary,
        sheets: xlsx.sheets.map((s) => ({
          handle: s.handle,
          name: s.name,
          rowCount: s.rowCount,
          colCount: s.colCount,
        })),
      };
    case "range": {
      const sheetName = focus.sheet ?? xlsx.sheets[0]?.name;
      if (!sheetName) return null;
      const sheet = xlsx.sheets.find((s) => s.name === sheetName);
      if (!sheet) return null;
      let cells = xlsx.cells.filter((c) => c.sheet === sheetName);
      if (focus.address) {
        const address = focus.address.toUpperCase();
        cells = cells.filter((c) => c.address.toUpperCase() === address);
        if (cells.length === 0) return null;
      }
      return {
        format: "xlsx",
        summary,
        sheets: [
          {
            handle: sheet.handle,
            name: sheet.name,
            rowCount: sheet.rowCount,
            colCount: sheet.colCount,
          },
        ],
        cells: cells.map((c) => ({
          handle: c.handle,
          sheet: c.sheet,
          address: c.address,
          value: c.value,
        })),
      };
    }
    case "headings":
    case "paragraphs":
    case "tables":
    case "slides":
    case "slide":
    case "context":
      return null;
    default: {
      const _exhaustive: never = focus;
      void _exhaustive;
      return null;
    }
  }
}

function collectMatches(
  document: DocumentRef,
  query: string,
  mode: "text" | "semantic",
  store: WorkingStore,
): FindMatch[] {
  const candidates = listSearchableBlocks(document, store);
  const matches: FindMatch[] = [];

  for (const candidate of candidates) {
    const score = matchScore(candidate.text, query, mode);
    if (score <= 0) continue;
    matches.push({
      handle: candidate.handle,
      excerpt: truncate(candidate.text, 160),
      location: candidate.location,
      score,
    });
  }

  return matches.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function listSearchableBlocks(
  document: DocumentRef,
  store: WorkingStore,
): readonly {
  handle: string;
  text: string;
  location: string;
}[] {
  if (document.format === "docx") {
    const docx = store.docx;
    return [
      ...docx.headings.map((h) => ({
        handle: h.handle,
        text: h.text,
        location: `Heading ${h.level}: ${h.text}`,
      })),
      ...docx.paragraphs.map((p, i) => ({
        handle: p.handle,
        text: p.text,
        location: `Paragraph ${i + 1}`,
      })),
      ...docx.tables.flatMap((t) =>
        t.preview.flatMap((row, ri) =>
          row.map((cell, ci) => ({
            handle: `${t.handle}:r${ri}c${ci}`,
            text: cell,
            location: `Table cell R${ri + 1}C${ci + 1}`,
          })),
        ),
      ),
    ];
  }

  if (document.format === "pptx") {
    return store.pptx.slides.flatMap((s) => [
      {
        handle: s.handle,
        text: [s.title ?? "", ...s.text].filter(Boolean).join(" — "),
        location: `Slide ${s.index + 1}${s.title ? `: ${s.title}` : ""}`,
      },
      ...s.text.map((line, i) => ({
        handle: `${s.handle}:t${i}`,
        text: line,
        location: `Slide ${s.index + 1} text`,
      })),
    ]);
  }

  return store.xlsx.cells.map((c) => ({
    handle: c.handle,
    text: c.value === null ? "" : String(c.value),
    location: `${c.sheet}!${c.address}`,
  }));
}

function matchScore(haystack: string, query: string, mode: "text" | "semantic"): number {
  if (!haystack) return 0;
  if (mode === "text") {
    return haystack.includes(query) ? 1 : 0;
  }
  const h = haystack.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (h === q) return 3;
  if (h.includes(q)) return 2;
  const tokens = q.split(/\s+/).filter(Boolean);
  const hit = tokens.filter((t) => h.includes(t)).length;
  return hit === 0 ? 0 : hit / tokens.length;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function applyMutation(
  document: DocumentRef,
  operation: DocumentOperation,
  store: WorkingStore,
): OperationResult {
  switch (operation.type) {
    case "document.replace_text":
      return mutateReplaceText(document, operation, store);
    case "slides.update_text":
      return mutateSlidesUpdateText(document, operation, store);
    case "workbook.set_cells":
      return mutateWorkbookSetCells(document, operation, store);
    default:
      return operationError(
        "VALIDATION_FAILED",
        `Unsupported mutation type: ${operation.type}`,
        { type: operation.type },
      );
  }
}

function mutateReplaceText(
  document: DocumentRef,
  operation: DocumentOperation,
  store: WorkingStore,
): OperationResult {
  if (document.format !== "docx") {
    return operationError(
      "VALIDATION_FAILED",
      "document.replace_text requires a DOCX document",
      { format: document.format },
    );
  }

  const find = readString(operation.payload.find);
  const replace = readString(operation.payload.replace);
  if (find === null || replace === null) {
    return operationError(
      "VALIDATION_FAILED",
      "document.replace_text requires string payload.find and payload.replace",
    );
  }
  if (find.length === 0) {
    return operationError(
      "VALIDATION_FAILED",
      "document.replace_text payload.find must be non-empty",
    );
  }

  const scopeRaw = operation.payload.scope;
  const scope =
    scopeRaw === undefined
      ? "all"
      : scopeRaw === "all" || scopeRaw === "headings" || scopeRaw === "paragraphs"
        ? scopeRaw
        : null;
  if (scope === null) {
    return operationError(
      "VALIDATION_FAILED",
      'document.replace_text payload.scope must be "all" | "headings" | "paragraphs"',
      { scope: scopeRaw },
    );
  }

  const docx = store.docx;
  type Hit = {
    kind: "heading" | "paragraph";
    index: number;
    handle: string;
    before: string;
  };
  const hits: Hit[] = [];

  if (scope === "all" || scope === "headings") {
    for (let i = 0; i < docx.headings.length; i++) {
      const heading = docx.headings[i]!;
      if (heading.text.includes(find)) {
        hits.push({
          kind: "heading",
          index: i,
          handle: heading.handle,
          before: heading.text,
        });
      }
    }
  }
  if (scope === "all" || scope === "paragraphs") {
    for (let i = 0; i < docx.paragraphs.length; i++) {
      const paragraph = docx.paragraphs[i]!;
      if (paragraph.text.includes(find)) {
        hits.push({
          kind: "paragraph",
          index: i,
          handle: paragraph.handle,
          before: paragraph.text,
        });
      }
    }
  }

  if (hits.length === 0) {
    return operationError(
      "TARGET_NOT_FOUND",
      `No text matching "${find}" found in DOCX ${scope}`,
      { find, scope },
    );
  }

  const afterParts: string[] = [];
  for (const hit of hits) {
    if (hit.kind === "heading") {
      const heading = docx.headings[hit.index]!;
      heading.text = heading.text.split(find).join(replace);
      afterParts.push(heading.text);
    } else {
      const paragraph = docx.paragraphs[hit.index]!;
      paragraph.text = paragraph.text.split(find).join(replace);
      afterParts.push(paragraph.text);
    }
  }

  const headingCount = hits.filter((h) => h.kind === "heading").length;
  const paragraphCount = hits.filter((h) => h.kind === "paragraph").length;
  const areaParts: string[] = [];
  if (headingCount > 0) areaParts.push(`${headingCount} heading(s)`);
  if (paragraphCount > 0) areaParts.push(`${paragraphCount} paragraph(s)`);

  return {
    status: "success",
    diagnostics: [],
    affected: hits.map((h) => semanticTarget(document, h.handle)),
    change: {
      operation: operation.type,
      area: areaParts.join(", "),
      before: hits.map((h) => h.before).join(" | "),
      after: afterParts.join(" | "),
    },
  };
}

function mutateSlidesUpdateText(
  document: DocumentRef,
  operation: DocumentOperation,
  store: WorkingStore,
): OperationResult {
  if (document.format !== "pptx") {
    return operationError(
      "VALIDATION_FAILED",
      "slides.update_text requires a PPTX document",
      { format: document.format },
    );
  }

  const slideIndex = readNumber(operation.payload.slideIndex);
  if (slideIndex === null || !Number.isInteger(slideIndex)) {
    return operationError(
      "VALIDATION_FAILED",
      "slides.update_text requires integer payload.slideIndex",
    );
  }

  const slide = store.pptx.slides.find((s) => s.index === slideIndex);
  if (!slide) {
    return operationError(
      "TARGET_NOT_FOUND",
      `Slide index ${slideIndex} not found`,
      { slideIndex },
    );
  }

  const titleField = operation.payload.title;
  if (titleField !== undefined) {
    if (typeof titleField !== "string") {
      return operationError(
        "VALIDATION_FAILED",
        "slides.update_text payload.title must be a string when provided",
      );
    }
    const before = slide.title ?? "";
    slide.title = titleField;
    return {
      status: "success",
      diagnostics: [],
      affected: [semanticTarget(document, slide.handle)],
      change: {
        operation: operation.type,
        area: `Slide ${slideIndex + 1} title`,
        before,
        after: titleField,
      },
    };
  }

  const existingText = readString(operation.payload.existingText);
  const newText = readString(operation.payload.newText);
  if (existingText === null || newText === null) {
    return operationError(
      "VALIDATION_FAILED",
      "slides.update_text requires payload.title or payload.existingText + payload.newText",
    );
  }

  if (slide.title === existingText) {
    const before = slide.title;
    slide.title = newText;
    return {
      status: "success",
      diagnostics: [],
      affected: [semanticTarget(document, slide.handle)],
      change: {
        operation: operation.type,
        area: `Slide ${slideIndex + 1} title`,
        before,
        after: newText,
      },
    };
  }

  const lineIndex = slide.text.findIndex((line) => line === existingText);
  if (lineIndex < 0) {
    return operationError(
      "TARGET_NOT_FOUND",
      `Text "${existingText}" not found on slide ${slideIndex}`,
      { slideIndex, existingText },
    );
  }

  const before = slide.text[lineIndex]!;
  slide.text[lineIndex] = newText;
  return {
    status: "success",
    diagnostics: [],
    affected: [semanticTarget(document, `${slide.handle}:t${lineIndex}`)],
    change: {
      operation: operation.type,
      area: `Slide ${slideIndex + 1} body`,
      before,
      after: newText,
    },
  };
}

function mutateWorkbookSetCells(
  document: DocumentRef,
  operation: DocumentOperation,
  store: WorkingStore,
): OperationResult {
  if (document.format !== "xlsx") {
    return operationError(
      "VALIDATION_FAILED",
      "workbook.set_cells requires an XLSX document",
      { format: document.format },
    );
  }

  const sheetName = readString(operation.payload.sheet);
  if (sheetName === null || sheetName.length === 0) {
    return operationError(
      "VALIDATION_FAILED",
      "workbook.set_cells requires non-empty payload.sheet",
    );
  }

  const cellsRaw = operation.payload.cells;
  if (!Array.isArray(cellsRaw) || cellsRaw.length === 0) {
    return operationError(
      "VALIDATION_FAILED",
      "workbook.set_cells requires non-empty payload.cells array",
    );
  }

  const sheet = store.xlsx.sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    return operationError(
      "TARGET_NOT_FOUND",
      `Sheet "${sheetName}" not found`,
      { sheet: sheetName },
    );
  }

  type CellUpdate = {
    address: string;
    value: string | number | null;
  };
  const updates: CellUpdate[] = [];
  for (const entry of cellsRaw) {
    if (!entry || typeof entry !== "object") {
      return operationError(
        "VALIDATION_FAILED",
        "workbook.set_cells cells entries must be objects",
      );
    }
    const record = entry as Record<string, unknown>;
    const address = readString(record.address);
    if (address === null || address.length === 0) {
      return operationError(
        "VALIDATION_FAILED",
        "workbook.set_cells cell.address must be a non-empty string",
      );
    }
    const value = record.value;
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number"
    ) {
      return operationError(
        "VALIDATION_FAILED",
        "workbook.set_cells cell.value must be string | number | null",
        { address },
      );
    }
    updates.push({ address: address.toUpperCase(), value: value as string | number | null });
  }

  const beforeParts: string[] = [];
  const afterParts: string[] = [];
  const affected: SemanticTarget[] = [];

  for (const update of updates) {
    let cell = store.xlsx.cells.find(
      (c) =>
        c.sheet === sheetName && c.address.toUpperCase() === update.address,
    );
    if (!cell) {
      cell = {
        sheet: sheetName,
        address: update.address,
        value: null,
        handle: `xlsx:c:${sheetName}!${update.address}`,
      };
      store.xlsx.cells.push(cell);
      beforeParts.push(`${update.address}=∅`);
    } else {
      beforeParts.push(
        `${update.address}=${cell.value === null ? "∅" : String(cell.value)}`,
      );
    }
    cell.value = update.value;
    afterParts.push(
      `${update.address}=${update.value === null ? "∅" : String(update.value)}`,
    );
    affected.push(semanticTarget(document, cell.handle));
  }

  return {
    status: "success",
    diagnostics: [],
    affected,
    change: {
      operation: operation.type,
      area: `${sheetName}!${updates.map((u) => u.address).join(",")}`,
      before: beforeParts.join(", "),
      after: afterParts.join(", "),
    },
  };
}

function semanticTarget(document: DocumentRef, handle: string): SemanticTarget {
  return {
    documentId: document.documentId,
    versionId: document.versionId,
    handle,
  };
}

function operationError(
  code: "TARGET_NOT_FOUND" | "VALIDATION_FAILED" | "PRECONDITION_FAILED",
  message: string,
  details?: Record<string, unknown>,
): OperationResult {
  return {
    status: "error",
    code,
    diagnostics: [
      {
        code,
        severity: "error",
        message,
        ...(details ? { details } : {}),
      },
    ],
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Test helper: expose fixture titles without parsing binaries. */
export function mockFixtureTitle(format: DocumentRef["format"]): string {
  if (format === "docx") return DOCX_BASE.title;
  if (format === "pptx") return PPTX_BASE.title;
  return XLSX_BASE.title;
}

/** Test helper: base DOCX heading text for immutability assertions. */
export function mockBaseHeadingText(handle: string): string | undefined {
  return DOCX_BASE.headings.find((h) => h.handle === handle)?.text;
}
