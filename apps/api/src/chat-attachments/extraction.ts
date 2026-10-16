import { createHash } from "node:crypto";
import { fork, type Serializable } from "node:child_process";
import { describeNativeEngine, type DocxEngineBinding } from "@opensuite/engine-client";
import { ChatAttachmentError, type ChatAttachmentDto, type ChatAttachmentService } from "./service.js";
import { CHAT_ATTACHMENT_MAX_BYTES } from "./validation.js";

export const VISUAL_PROCESSOR_VERSION = "sharp-0.35.4-pdfjs-5.6.205-visual-v1";
export type VisualContent = { width: number; height: number; mimeType: string; representation: { mediaType: "image/jpeg"; width: number; height: number; base64: string } };
export const EXTRACTOR_VERSION = "attachment-text-v1";
export const EXTRACTION_MAX_CHARACTERS = 1_000_000;
export const EXTRACTION_MAX_UNITS = 20_000;
export type AttachmentUnit = {
  location: string;
  text: string;
  section: string[];
  headingLevel?: number;
  list?: { kind: string; level: number; supported: boolean };
  page?: {
    number: number;
    label?: string;
    width: number;
    height: number;
    rotation: number;
    coordinateSpace: "pdf_user_space";
    textStatus: "digital_text" | "limited_text" | "no_text" | "failed";
    warnings: string[];
    lines: { textOffset: number; length: number; x: number; y: number; width: number; height: number; direction: string }[];
    remainingLines: number;
  };
};
export type PdfStructure = {
  title?: string;
  pageCount: number;
  processedPages: number;
  complete: boolean;
  metadata: Record<string, string>;
  outline: { title: string; level: number; location?: string }[];
  outlineComplete: boolean;
  options: typeof PDF_EXTRACTION_OPTIONS;
};
// Fixed policy and parser version are part of PDF cache identity.
export const PDF_EXTRACTOR_VERSION = "pdfjs-5.6.205-policy-v1";
export const PDF_EXTRACTION_OPTIONS = { maxPages: 500, maxPageItems: 20_000, maxItems: 100_000, maxCharacters: 1_000_000, maxPageLines: 64, maxBookmarks: 100, maxOutputBytes: 3_500_000 } as const;
export type AttachmentExtraction = {
  attachmentId: string;
  sha256: string;
  extractionId: string;
  extractor: string;
  units: AttachmentUnit[];
  limitations: string[];
  pdf?: PdfStructure;
  image?: VisualContent;
  renderedPage?: { page: number; version: string; visual: VisualContent };
};
export type ExtractionContent = Pick<AttachmentExtraction, "units" | "limitations" | "pdf" | "image">;
export type AttachmentScope = { workspaceId: string; userId: string; threadId: string };
export type AttachmentSource = Pick<ChatAttachmentService, "getBound" | "list" | "read" | "readExtraction" | "saveExtraction">;

export function extractionError(code: string, message: string): never {
  throw new ChatAttachmentError(400, code, message);
}

export function checkExtractionSize(units: AttachmentUnit[], characters: number) {
  if (units.length > EXTRACTION_MAX_UNITS || characters > EXTRACTION_MAX_CHARACTERS) {
    extractionError("EXTRACTION_LIMIT", "Attachment exceeds the extraction limit (20,000 locations or 1,000,000 characters)");
  }
}

/** Bound ZIP expansion using directory metadata only; Office XML stays inside the engine. */
export function checkDocxArchive(bytes: Buffer) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0) extractionError("INVALID_DOCX", "DOCX ZIP directory is missing");
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  let position = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || count > 2048 || position + directorySize !== end) extractionError("EXTRACTION_LIMIT", "Unsupported ZIP layout or too many DOCX parts");
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) extractionError("INVALID_DOCX", "Invalid DOCX ZIP directory");
    total += bytes.readUInt32LE(position + 24);
    if (total > 64 * 1024 * 1024 || bytes.readUInt32LE(position + 20) === 0xffffffff || bytes.readUInt32LE(position + 42) === 0xffffffff || bytes.readUInt16LE(position + 34) !== 0 || bytes.readUInt16LE(position + 8) & 1) extractionError("EXTRACTION_LIMIT", "Encrypted, ZIP64, or oversized DOCX archives are not extracted");
    position += 46 + bytes.readUInt16LE(position + 28) + bytes.readUInt16LE(position + 30) + bytes.readUInt16LE(position + 32);
  }
  if (position !== end) extractionError("INVALID_DOCX", "Invalid DOCX ZIP directory length");
}

export function extractText(bytes: Buffer, markdown: boolean): Pick<AttachmentExtraction, "units" | "limitations"> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    return extractionError("INVALID_ENCODING", "Text attachments must use valid UTF-8 (an optional UTF-8 BOM is accepted)");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) extractionError("INVALID_ENCODING", "Text attachment contains binary control characters");
  const units: AttachmentUnit[] = [];
  let characters = 0;
  let section: string[] = [];
  let headings: { level: number; title: string }[] = [];
  let previousCanBeHeading = false;
  let fence: { marker: string; length: number } | undefined;
  const lines = text.split("\n");
  checkExtractionSize([], text.length);
  for (const [index, line] of lines.entries()) {
    const marker = markdown ? /^ {0,3}(`{3,}|~{3,})/.exec(line) : null;
    const inFence = !!fence;
    if (marker) {
      if (!fence) fence = { marker: marker[1]![0]!, length: marker[1]!.length };
      else if (marker[1]![0] === fence.marker && marker[1]!.length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) fence = undefined;
    }
    const heading = markdown && !inFence && !marker ? /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line) : null;
    const setext: RegExpExecArray | null | false = markdown && !inFence && !marker && previousCanBeHeading && index > 0 && /^ {0,3}(=+|-+)\s*$/.exec(line);
    let level = heading?.[1]?.length;
    let title = heading?.[2];
    if (setext && lines[index - 1]!.trim() && units.at(-1)?.headingLevel === undefined) {
      level = setext[1]![0] === "=" ? 1 : 2;
      title = lines[index - 1]!.trim();
      units.at(-1)!.headingLevel = level;
    }
    if (level && title) {
      headings = [...headings.filter(heading => heading.level < level), { level, title }];
      section = headings.map(heading => heading.title);
      if (setext) units.at(-1)!.section = [...section];
    }
    units.push({ location: `line:${index + 1}`, text: line, section: [...section], ...(heading ? { headingLevel: level } : {}) });
    previousCanBeHeading = !inFence && !marker && !heading && !setext && !!line.trim();
    characters += line.length + section.join("/").length;
    checkExtractionSize(units, characters);
  }
  return { units, limitations: markdown ? ["Markdown is source text only; embedded HTML, links, and scripts are never executed or fetched."] : [] };
}

export function createAttachmentExtractionService(source: AttachmentSource, binding?: DocxEngineBinding) {
  // Only the selected native binary affects DOCX cache identity; no native handles are persisted.
  let nativeIdentity: ReturnType<typeof describeNativeEngine> | undefined;
  const preparedPages = new Map<string, VisualContent>();
  const pendingRenders = new Map<string, Promise<VisualContent>>();
  const pending = new Map<string, Promise<AttachmentExtraction>>();
  let activeReaders = 0;
  async function worker<T>(name: string, payload: Serializable, nativePath?: string): Promise<T> {
    if (activeReaders >= 2) extractionError("EXTRACTION_BUSY", "Attachment readers are busy; retry shortly");
    activeReaders++;
    try {
      return await new Promise<T>((resolve, reject) => {
        const child = fork(new URL(`./${name}.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url), [], {
          stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
          execArgv: [...process.execArgv, "--max-old-space-size=128"],
          env: { ...process.env, ...(nativePath ? { OPENSUITE_ENGINE_PATH: nativePath } : {}) },
        });
        let settled = false;
        const deadline = setTimeout(() => finish(new ChatAttachmentError(400, "EXTRACTION_TIMEOUT", "Attachment processing exceeded 10 seconds")), 10_000);
        function finish(error?: Error, content?: T) {
          if (settled) return;
          settled = true; clearTimeout(deadline); child.kill("SIGKILL");
          if (error) reject(error); else resolve(content!);
        }
        child.once("error", () => finish(new ChatAttachmentError(400, "EXTRACTION_FAILED", "Attachment reader could not start")));
        child.once("exit", () => finish(new ChatAttachmentError(400, "EXTRACTION_FAILED", "Attachment reader stopped before completion")));
        child.once("message", message => {
          const result = message as { content?: T; code?: string };
          if (result.content) finish(undefined, result.content);
          else finish(new ChatAttachmentError(400, result.code ?? "EXTRACTION_FAILED", result.code === "PDF_PASSWORD_REQUIRED" ? "Encrypted/password-protected PDFs are not supported" : "Attachment could not be processed safely"));
        });
        child.send(payload);
      });
    } finally { activeReaders--; }
  }
  async function original(scope: AttachmentScope, meta: ChatAttachmentDto) {
    await source.getBound({ ...scope, attachmentId: meta.id });
    const object = await source.read({ ...scope, attachmentId: meta.id });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => object.body.destroy(new Error("Attachment read deadline exceeded")), 10_000);
    try {
      for await (const chunk of object.body) {
        size += chunk.length;
        if (size > CHAT_ATTACHMENT_MAX_BYTES || size > meta.sizeBytes) extractionError("EXTRACTION_LIMIT", "Attachment bytes exceed the declared limit");
        chunks.push(Buffer.from(chunk));
      }
    } finally { clearTimeout(timer); object.body.destroy(); }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== meta.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== meta.sha256) extractionError("ATTACHMENT_CHANGED", "Original attachment bytes do not match their recorded hash");
    return bytes;
  }
  async function identity(meta: ChatAttachmentDto) {
    const native = meta.mediaType.endsWith("wordprocessingml.document") && binding
      ? await (nativeIdentity ??= describeNativeEngine(binding)) : undefined;
    const extractor = `${EXTRACTOR_VERSION}${meta.mediaType.startsWith("image/") ? `:${VISUAL_PROCESSOR_VERSION}` : ""}${meta.mediaType === "application/pdf" ? `:${PDF_EXTRACTOR_VERSION}` : ""}${native ? `:docx:${native.engineVersion}:${native.binarySha256 ?? native.modulePath}` : ""}`;
    const extractionId = createHash("sha256").update(`${meta.id}:${meta.sha256}:${meta.mediaType}:${extractor}`).digest("hex");
    return { extractor, extractionId, native };
  }
  async function cached(scope: AttachmentScope, meta: ChatAttachmentDto): Promise<AttachmentExtraction | null> {
    const { extractionId } = await identity(meta);
    const bytes = await source.readExtraction({ ...scope, attachmentId: meta.id });
    if (!bytes) return null;
    try {
      const value = JSON.parse(bytes.toString("utf8")) as AttachmentExtraction;
      if (value.attachmentId === meta.id && value.sha256 === meta.sha256 && value.extractionId === extractionId && Array.isArray(value.units)) return value;
    } catch { /* Replace an incomplete or obsolete cache on the next extraction. */ }
    return null;
  }
  async function extract(scope: AttachmentScope, meta: ChatAttachmentDto): Promise<AttachmentExtraction> {
    const existing = await cached(scope, meta);
    if (existing) return existing;
    const isDocx = meta.mediaType.endsWith("wordprocessingml.document");
    const isPdf = meta.mediaType === "application/pdf";
    const isImage = ["image/png", "image/jpeg"].includes(meta.mediaType);
    if (!isImage && !["text/plain", "text/markdown"].includes(meta.mediaType) && !isDocx && !isPdf) extractionError("EXTRACTION_UNSUPPORTED", "Text extraction supports TXT, Markdown, DOCX, and PDF; images require visual interpretation");
    const { extractor, extractionId, native } = await identity(meta);
    if (isDocx && !native) extractionError("EXTRACTION_UNAVAILABLE", "Native DOCX reader is unavailable");
    const bytes = await original(scope, meta);
    let content: ExtractionContent;
    if (isImage) content = { units: [], limitations: ["Image metadata is not visual understanding. Only supplied visual input or attributed model observations support visual claims."],
      image: await worker<VisualContent>("visual-worker", { bytes, mediaType: meta.mediaType }) };
    else if (!isDocx && !isPdf) content = extractText(bytes, meta.mediaType === "text/markdown");
    else {
      if (isDocx) checkDocxArchive(bytes);
      if (isPdf && !/^%PDF-\d\.\d/.test(bytes.subarray(0, 8).toString("ascii"))) extractionError("INVALID_PDF", "PDF header is missing or invalid");
      content = await worker<ExtractionContent>(`${isPdf ? "pdf" : "docx"}-extraction-worker`, bytes, native?.binaryPath ?? native?.modulePath);
    }
    const result = { attachmentId: meta.id, sha256: meta.sha256, extractionId, extractor, ...content };
    await source.saveExtraction({ ...scope, attachmentId: meta.id, bytes: Buffer.from(JSON.stringify(result)) });
    return result;
  }
  return {
    source,
    cached,
    async view(scope: AttachmentScope, attachmentId: string, extractionId: string, page?: number) {
      const { meta, extraction } = await this.get(scope, attachmentId);
      if (extraction.extractionId !== extractionId) extractionError("STALE_EXTRACTION", "Attachment extraction changed; use the current manifest reference");
      if (extraction.image && page === undefined) return { meta, extraction, visual: extraction.image };
      if (!extraction.pdf || !Number.isInteger(page) || page! < 1 || page! > extraction.pdf.pageCount) extractionError("INVALID_REFERENCE", "Select an image or one valid physical PDF page");
      const key = `${scope.userId}:${scope.threadId}:${meta.id}:${meta.sha256}:${page}`;
      const prepared = preparedPages.get(key);
      if (prepared) return { meta, extraction, visual: prepared };
      let work = pendingRenders.get(key);
      if (!work) {
        work = (async () => {
          const current = await cached(scope, meta) ?? extraction;
          if (current.renderedPage && current.renderedPage.page === page && current.renderedPage.version === VISUAL_PROCESSOR_VERSION) return current.renderedPage.visual;
          const visual = await worker<VisualContent>("visual-worker", { bytes: await original(scope, meta), mediaType: meta.mediaType, page });
          // Keep only the latest page: derivative cache is bounded even for large PDFs.
          await source.saveExtraction({ ...scope, attachmentId, bytes: Buffer.from(JSON.stringify({ ...current, renderedPage: { page, version: VISUAL_PROCESSOR_VERSION, visual } })) });
          return visual;
        })();
        pendingRenders.set(key, work);
      }
      try {
        const visual = await work;
        preparedPages.delete(key); preparedPages.set(key, visual);
        if (preparedPages.size > 4) preparedPages.delete(preparedPages.keys().next().value!);
        await source.getBound({ ...scope, attachmentId });
        return { meta, extraction, visual };
      } finally { if (pendingRenders.get(key) === work) pendingRenders.delete(key); }
    },
    async get(scope: AttachmentScope, attachmentId: string) {
      const meta = await source.getBound({ ...scope, attachmentId });
      const key = `${scope.userId}:${scope.threadId}:${meta.id}:${meta.sha256}`;
      let work = pending.get(key);
      if (!work) {
        work = extract(scope, meta);
        pending.set(key, work);
      }
      try {
        const extraction = await work;
        await source.getBound({ ...scope, attachmentId });
        return { meta, extraction };
      } finally { if (pending.get(key) === work) pending.delete(key); }
    },
  };
}
export type AttachmentExtractionService = ReturnType<typeof createAttachmentExtractionService>;
