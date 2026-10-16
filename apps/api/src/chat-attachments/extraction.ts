import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { describeNativeEngine, type DocxEngineBinding } from "@opensuite/engine-client";
import { ChatAttachmentError, type ChatAttachmentDto, type ChatAttachmentService } from "./service.js";
import { CHAT_ATTACHMENT_MAX_BYTES } from "./validation.js";

export const EXTRACTOR_VERSION = "attachment-text-v1";
export const EXTRACTION_MAX_CHARACTERS = 1_000_000;
export const EXTRACTION_MAX_UNITS = 20_000;
export type AttachmentUnit = {
  location: string;
  text: string;
  section: string[];
  headingLevel?: number;
  list?: { kind: string; level: number; supported: boolean };
};
export type AttachmentExtraction = {
  attachmentId: string;
  sha256: string;
  extractionId: string;
  extractor: string;
  units: AttachmentUnit[];
  limitations: string[];
};
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
  const pending = new Map<string, Promise<AttachmentExtraction>>();
  let activeReaders = 0;
  async function identity(meta: ChatAttachmentDto) {
    const native = meta.mediaType.endsWith("wordprocessingml.document") && binding
      ? await (nativeIdentity ??= describeNativeEngine(binding)) : undefined;
    const extractor = `${EXTRACTOR_VERSION}${native ? `:docx:${native.engineVersion}:${native.binarySha256 ?? native.modulePath}` : ""}`;
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
    if (!["text/plain", "text/markdown"].includes(meta.mediaType) && !isDocx) extractionError("EXTRACTION_UNSUPPORTED", "Text extraction supports TXT, Markdown, and DOCX; PDF and images are not inspected yet");
    const { extractor, extractionId, native } = await identity(meta);
    if (isDocx && !native) extractionError("EXTRACTION_UNAVAILABLE", "Native DOCX reader is unavailable");
    const object = await source.read({ ...scope, attachmentId: meta.id });
    const chunks: Buffer[] = [];
    let size = 0;
    // A stalled storage stream must not keep an extraction alive indefinitely.
    const timer = setTimeout(() => object.body.destroy(new Error("Attachment read deadline exceeded")), 10_000);
    try {
      for await (const chunk of object.body) {
        size += chunk.length;
        if (size > CHAT_ATTACHMENT_MAX_BYTES || size > meta.sizeBytes) extractionError("EXTRACTION_LIMIT", "Attachment bytes exceed the declared limit");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      clearTimeout(timer);
      object.body.destroy();
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== meta.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== meta.sha256) extractionError("ATTACHMENT_CHANGED", "Original attachment bytes do not match their recorded hash");
    let content: Pick<AttachmentExtraction, "units" | "limitations">;
    if (!isDocx) content = extractText(bytes, meta.mediaType === "text/markdown");
    else {
      checkDocxArchive(bytes);
      if (activeReaders >= 2) extractionError("EXTRACTION_BUSY", "DOCX readers are busy; retry shortly");
      activeReaders++;
      try {
        content = await new Promise((resolve, reject) => {
          const child = fork(new URL(import.meta.url.endsWith(".ts") ? "./docx-extraction-worker.ts" : "./docx-extraction-worker.js", import.meta.url), [], {
            stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
            execArgv: [...process.execArgv, "--max-old-space-size=128"],
            env: { ...process.env, OPENSUITE_ENGINE_PATH: native!.binaryPath ?? native!.modulePath },
          });
          const deadline = setTimeout(() => finish(new ChatAttachmentError(400, "EXTRACTION_TIMEOUT", "DOCX extraction exceeded 10 seconds")), 10_000);
          let settled = false;
          function finish(error?: Error, result?: typeof content) {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            child.kill("SIGKILL");
            if (error) reject(error); else resolve(result!);
          }
          child.once("error", () => finish(new ChatAttachmentError(400, "EXTRACTION_FAILED", "DOCX reader could not start")));
          child.once("exit", () => finish(new ChatAttachmentError(400, "EXTRACTION_FAILED", "DOCX reader stopped before extraction completed")));
          child.once("message", (message) => {
            const result = message as { content?: typeof content; code?: string };
            if (result.content) finish(undefined, result.content);
            else finish(new ChatAttachmentError(400, result.code ?? "INVALID_DOCX", "DOCX could not be extracted safely"));
          });
          child.send(bytes);
        });
      } finally { activeReaders--; }
    }
    const result = { attachmentId: meta.id, sha256: meta.sha256, extractionId, extractor, ...content };
    await source.saveExtraction({ ...scope, attachmentId: meta.id, bytes: Buffer.from(JSON.stringify(result)) });
    return result;
  }
  return {
    source,
    cached,
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
