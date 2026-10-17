// @ts-check
/** @typedef {import("pdfjs-dist/types/src/display/api.js").RenderParameters} RenderParameters */
import sharp from "sharp";
import { fileURLToPath } from "node:url";

// Runs in the same bounded, disposable reader process as text extraction.
Reflect.defineProperty(globalThis, "fetch", { value: async () => { throw new Error("Attachment network access is disabled"); } });
sharp.cache(false);
sharp.concurrency(1);
console.log = console.warn = console.error = () => {};
const memoryCheck = setInterval(() => {
  if (process.memoryUsage().rss > 384 * 1024 * 1024) {
    process.send?.({ code: "EXTRACTION_LIMIT", stage: "worker_memory" }, () => process.exit(0));
  }
}, 50);
process.once("message", /** @param {{ bytes: Buffer; mediaType: string; page?: number }} input */ async (input) => {
  let stage = "image_decode";
  try {
    let bytes = input.bytes;
    /** @type {number} */
    let width;
    /** @type {number} */
    let height;
    if (input.mediaType === "application/pdf") {
      stage = "pdf_import";
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const root = new URL("./", import.meta.resolve("pdfjs-dist/package.json"));
      let warning = false;
      console.log = console.warn = console.error = () => { warning = true; };
      stage = "pdf_open";
      const document = await getDocument({ data: Uint8Array.from(bytes), verbosity: 1,
        isEvalSupported: false, useWasm: false, useWorkerFetch: false, useSystemFonts: false,
        disableFontFace: true, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
        stopAtErrors: true, maxImageSize: 16_000_000, canvasMaxAreaInBytes: 16_000_000,
        cMapUrl: fileURLToPath(new URL("cmaps/", root)), cMapPacked: true,
        standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", root)),
      }).promise;
      const { info } = await document.getMetadata();
      if ((/** @type {Record<string, unknown>} */ (info)).EncryptFilterName) throw new Error("Encrypted PDF");
      if (document.numPages > 500 || typeof input.page !== "number" || !Number.isInteger(input.page) || input.page < 1 || input.page > document.numPages) throw new Error("Invalid page");
      stage = "pdf_render";
      const page = await document.getPage(input.page);
      const original = page.getViewport({ scale: 1 });
      if (![original.width, original.height].every(value => Number.isFinite(value) && value > 0 && value <= 100_000)) throw new Error("Invalid dimensions");
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / Math.max(original.width, original.height)) });
      width = Math.ceil(viewport.width); height = Math.ceil(viewport.height);
      const factory = /** @type {{ create(width: number, height: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown }; destroy(target: unknown): void }} */ (document.canvasFactory);
      const target = factory.create(width, height);
      await page.render({ canvas: /** @type {RenderParameters["canvas"]} */ (/** @type {unknown} */ (target.canvas)), canvasContext: /** @type {RenderParameters["canvasContext"]} */ (target.context), viewport }).promise;
      // Do not present a partially decoded page as successful visual evidence.
      if (warning) throw new Error("Incomplete PDF render");
      bytes = target.canvas.toBuffer("image/png");
      factory.destroy(target);
      await document.destroy();
    } else {
      const metadata = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" }).metadata();
      if ((metadata.format === "png" ? "image/png" : metadata.format === "jpeg" ? "image/jpeg" : "") !== input.mediaType || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw new Error("Invalid image");
      width = metadata.width; height = metadata.height;
    }
    stage = "image_encode";
    const result = await sharp(bytes, { limitInputPixels: 16_000_000, failOn: "warning" })
      .rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "white" }).jpeg({ quality: 85 }).timeout({ seconds: 5 }).toBuffer({ resolveWithObject: true });
    if (result.data.length > 350_000) throw new Error("Visual representation too large");
    process.send?.({ content: { width, height, mimeType: input.mediaType,
      representation: { mediaType: "image/jpeg", width: result.info.width, height: result.info.height, base64: result.data.toString("base64") } } });
  } catch (error) { process.send?.({ code: input.mediaType === "application/pdf" ? stage === "pdf_import" ? "PDF_WORKER_FAILED" : "PDF_RENDER_FAILED" : "VISUAL_PROCESSING_FAILED",
    stage, stack: error instanceof Error ? error.stack?.split("\n").filter(line => /^\s+at /.test(line)).slice(0, 8) : undefined }); }
  finally { clearInterval(memoryCheck); }
});
