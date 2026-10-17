// @ts-check
import { fileURLToPath } from "node:url";
import { PDF_EXTRACTION_OPTIONS as limits } from "./pdf-options.mjs";
/** @typedef {import("pdfjs-dist/types/src/display/api.js").PDFDocumentProxy} PDFDocumentProxy */
/** @typedef {import("pdfjs-dist/types/src/display/api.js").TextItem} TextItem */
/** @typedef {import("./extraction.js").PdfStructure} PdfStructure */
/** @typedef {import("./extraction.js").ExtractionContent} ExtractionContent */
/** @typedef {import("./extraction.js").AttachmentUnit} AttachmentUnit */

// No viewer, rendering, annotation actions, JavaScript, URLs, or document attachments are opened.
Reflect.defineProperty(globalThis, "fetch", { value: async () => { throw new Error("PDF network access is disabled"); } });
const warnings = [
  "PDF text follows content-stream order with geometric line breaks; columns and complex reading order may be imperfect. No headings or table cells are inferred. Tabular structure and numeric row relationships may be incomplete; verify against the page when ambiguous.",
  "Images, charts, handwriting, annotations, forms, and embedded files are not interpreted. A page without extractable text is not necessarily blank; visual interpretation requires Part 6.",
];
/** @param {number} value */
const round = (value) => Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
/** @param {unknown} value */
const short = (value, length = 240) => typeof value === "string" ? value.replace(/\x00/g, "").trim().slice(0, length) : "";

/** @param {PDFDocumentProxy} document @param {PdfStructure} pdf */
async function bookmarks(document, pdf) {
  const pending = (await document.getOutline() ?? []).map(item => ({ item, level: 1 }));
  while (pending.length && pdf.outline.length < limits.maxBookmarks) {
    const next = pending.shift();
    if (!next) break;
    const { item, level } = next;
    /** @type {string | undefined} */
    let location;
    // Only resolve internal destinations. URL/action bookmarks remain text-only labels.
    try {
      const dest = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
      if (Array.isArray(dest) && dest.length) {
        const index = typeof dest[0] === "number" ? dest[0] : await document.getPageIndex(dest[0]);
        if (Number.isInteger(index) && index >= 0 && index < document.numPages) location = `page:${index + 1}`;
      }
    } catch { /* An unresolved bookmark does not invent a page reference. */ }
    pdf.outline.push({ title: short(item.title, 160), level, ...(location ? { location } : {}) });
    if (level < 8) pending.unshift(...item.items.slice(0, limits.maxBookmarks).map(item => ({ item, level: level + 1 })));
    if (level >= 8 && item.items.length || item.items.length > limits.maxBookmarks) pdf.outlineComplete = false;
  }
  if (pending.length) pdf.outlineComplete = false;
}

process.once("message", /** @param {Buffer} input */ async (input) => {
  /** @type {PDFDocumentProxy | undefined} */
  let document;
  let stage = "pdf_import";
  let currentPage = 0;
  const parserWarnings = new Set();
  // PDF.js can recover internally instead of rejecting. Keep only the affected page,
  // never its diagnostic text, which can contain source content.
  const recordWarning = () => { parserWarnings.add(currentPage); };
  console.log = recordWarning; console.warn = recordWarning; console.error = recordWarning;
  // Parent also enforces a wall-clock kill deadline even when parsing blocks this event loop.
  const memoryCheck = setInterval(() => {
    if (process.memoryUsage().rss > 384 * 1024 * 1024) {
      process.send?.({ code: "EXTRACTION_LIMIT" }, () => process.exit(0));
    }
  }, 50);
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const packageRoot = new URL("./", import.meta.resolve("pdfjs-dist/package.json"));
    stage = "pdf_open";
    document = await getDocument({
      data: Uint8Array.from(input), verbosity: 1, isEvalSupported: false,
      useWasm: false, useWorkerFetch: false, useSystemFonts: false, disableFontFace: true,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false, stopAtErrors: true,
      cMapUrl: fileURLToPath(new URL("cmaps/", packageRoot)), cMapPacked: true,
      standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", packageRoot)),
    }).promise;
    stage = "pdf_metadata";
    /** @type {PdfStructure} */
    const pdf = { pageCount: document.numPages, processedPages: 0, complete: true,
      metadata: {}, outline: [], outlineComplete: true, options: limits };
    try {
      const { info: rawInfo, metadata } = await document.getMetadata();
      const info = /** @type {Record<string, unknown>} */ (rawInfo);
      if (info.EncryptFilterName) throw new Error("PDF_PASSWORD_REQUIRED");
      for (const key of ["Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate", "Language", "PDFFormatVersion"]) {
        const value = short(info[key]);
        if (value) pdf.metadata[key] = value;
      }
      const title = short(info.Title || metadata?.get("dc:title"));
      if (title) pdf.title = title;
    } catch (error) {
      if (error instanceof Error && error.message === "PDF_PASSWORD_REQUIRED") throw error;
      warnings.push("PDF metadata could not be read.");
    }
    // Extremely large files fail before walking a potentially hostile page tree.
    if (!Number.isInteger(pdf.pageCount) || pdf.pageCount < 1 || pdf.pageCount > limits.maxPages) throw new Error("EXTRACTION_LIMIT");
    try { await bookmarks(document, pdf); } catch { pdf.outlineComplete = false; warnings.push("PDF bookmarks could not be fully read."); }
    /** @type {string[] | null} */
    let labels = null;
    try { labels = await document.getPageLabels(); } catch { warnings.push("PDF page labels could not be read."); }
    /** @type {ExtractionContent} */
    const content = { units: [], limitations: [...warnings], pdf };
    if (parserWarnings.has(0)) content.limitations.push("The PDF parser reported a document-level recovery or resource warning; text or metadata may be incomplete.");
    let characters = 0;
    let items = 0;
    for (let number = 1; number <= pdf.pageCount; number++) {
      stage = "pdf_page_text";
      currentPage = number;
      /** @type {AttachmentUnit} */
      const unit = { location: `page:${number}`, text: "", section: [], page: {
        number, ...(labels?.[number - 1] ? { label: short(labels[number - 1], 80) } : {}),
        width: 0, height: 0, rotation: 0, coordinateSpace: "pdf_user_space", textStatus: "digital_text", warnings: [], lines: [], remainingLines: 0,
      } };
      const facts = /** @type {NonNullable<AttachmentUnit["page"]>} */ (unit.page);
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      facts.width = round(viewport.width); facts.height = round(viewport.height); facts.rotation = page.rotate;
      const reader = page.streamTextContent({ disableNormalization: true }).getReader();
      /** @type {TextItem | undefined} */
      let previous;
      /** @type {(typeof facts.lines)[number] | undefined} */
      let line;
      let pageItems = 0;
      let lineCount = 0;
      let stopped = false;
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          for (const item of /** @type {TextItem[]} */ (chunk.value.items)) {
            if (!("str" in item)) continue;
            if (++pageItems > limits.maxPageItems || ++items > limits.maxItems || characters + item.str.length + 1 > limits.maxCharacters) {
              facts.warnings.push("Extraction stopped at the text/item limit; this page and later pages may contain omitted text.");
              pdf.complete = false; stopped = true; break;
            }
            if (!item.str && !item.hasEOL) continue;
            const height = Math.abs(item.height) || Math.hypot(item.transform[2], item.transform[3]);
            const newLine = !previous || previous.hasEOL || Math.abs(item.transform[5] - previous.transform[5]) > Math.max(2, height * 0.4);
            let separator = "";
            if (unit.text) {
              if (newLine) separator = "\n";
              else if (previous && !/\s$/.test(unit.text) && !/^\s/.test(item.str) && Math.abs(item.transform[4] - (previous.transform[4] + previous.width)) > Math.max(1, height * 0.15)) separator = " ";
            }
            unit.text += separator;
            if (newLine) {
              lineCount++;
              line = { textOffset: unit.text.length, length: 0, x: round(item.transform[4]), y: round(item.transform[5]), width: 0, height: round(height), direction: item.dir };
              if (facts.lines.length < limits.maxPageLines) facts.lines.push(line);
            }
            unit.text += item.str;
            if (line) { line.length = unit.text.length - line.textOffset; line.width = round(Math.max(line.width, item.transform[4] + item.width - line.x)); }
            characters += item.str.length + separator.length;
            previous = item;
          }
        }
      } catch {
        facts.textStatus = "failed"; pdf.complete = false;
        facts.warnings.push("Page text extraction failed; available text may be incomplete. Visual interpretation is needed.");
      } finally {
        // PDF.js may race stream cancellation with queued chunks. The parent kills this
        // short-lived process after our bounded result, including any unfinished stream.
        reader.releaseLock();
        if (!stopped) page.cleanup();
      }
      facts.remainingLines = Math.max(0, lineCount - facts.lines.length);
      if (parserWarnings.has(number)) {
        facts.warnings.push("The PDF parser reported a page decoding/resource problem. Extracted text may be incomplete; visual interpretation may be needed.");
        if (!unit.text.trim()) facts.textStatus = "failed";
        pdf.complete = false;
      }
      if (facts.textStatus !== "failed") {
        const count = (unit.text.match(/[\p{L}\p{N}]/gu) ?? []).length;
        facts.textStatus = !unit.text.trim() ? "no_text" : count < 20 || unit.text.includes("\ufffd") || facts.warnings.length ? "limited_text" : "digital_text";
        if (facts.textStatus === "no_text") facts.warnings.push("No extractable text. This page may contain images or other information; do not call it blank. Visual interpretation is needed.");
        if (facts.textStatus === "limited_text") facts.warnings.push("Limited or suspicious text extraction; visual content may be missing. Visual interpretation may be needed.");
      }
      content.units.push(unit);
      pdf.processedPages = number;
      if (Buffer.byteLength(JSON.stringify(content)) > limits.maxOutputBytes) {
        content.units.pop(); pdf.processedPages--; pdf.complete = false; break;
      }
      if (items > limits.maxItems || characters >= limits.maxCharacters || pageItems > limits.maxPageItems) break;
      // A character limit may stop before adding the next text item.
      if (facts.warnings.some(warning => warning.startsWith("Extraction stopped"))) break;
    }
    if (!pdf.complete || pdf.processedPages < pdf.pageCount) {
      pdf.complete = false;
      content.limitations.push(`PDF extraction is partial: ${pdf.processedPages} of ${pdf.pageCount} physical pages processed. Omitted pages/text are unavailable, not empty.`);
    }
    process.send?.({ content });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : "";
    process.send?.({ code: name === "PasswordException" || message === "PDF_PASSWORD_REQUIRED" ? "PDF_PASSWORD_REQUIRED" : message === "EXTRACTION_LIMIT" ? "EXTRACTION_LIMIT" : stage === "pdf_import" || message.startsWith("Setting up fake worker failed") ? "PDF_WORKER_FAILED" : "INVALID_PDF",
      stage, stack: error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 8) : undefined });
  } finally { clearInterval(memoryCheck); }
});
