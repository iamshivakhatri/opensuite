import {
  refreshDocxFields,
  type DocxEngineBinding,
  type DocxField,
  type DocxFieldRefreshResult,
} from "@opensuite/engine-client";

const TOC_PLACEHOLDER = /update this table of contents|right-click|update field|refresh/i;

export function tocNeedsExternalRefresh(field: Pick<DocxField, "kind" | "dirty" | "cachedResult">): boolean {
  if (field.kind !== "toc") return false;
  if (field.dirty === true) return true;
  const cached = (field.cachedResult ?? "").trim();
  if (!cached) return true;
  return TOC_PLACEHOLDER.test(cached);
}

export function fieldsNeedExternalRefresh(fields: readonly DocxField[]): boolean {
  return fields.some((field) => {
    if (tocNeedsExternalRefresh(field)) return true;
    if ((field.kind === "page" || field.kind === "numPages") && (field.dirty === true || field.cachedResult === "?")) {
      return true;
    }
    return false;
  });
}

export interface FieldRefreshAcceptance {
  readonly ok: boolean;
  readonly reason?: string;
  readonly tocPopulated?: boolean;
  readonly pageFields?: number;
}

/** List ZIP entry names from a DOCX package (central directory only). */
export function listDocxPartNames(bytes: Uint8Array): string[] {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = view.getUint32(eocd + 16, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const names: string[] = [];
  const decoder = new TextDecoder("utf-8");
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) break;
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const start = offset + 46;
    const end = start + nameLen;
    if (end > bytes.length) break;
    names.push(decoder.decode(bytes.subarray(start, end)));
    offset = end + extraLen + commentLen;
  }
  return names;
}

function protectedPackageParts(names: readonly string[]): string[] {
  return names.filter((name) => /^(customXml\/|embeddings\/|glossary\/)/i.test(name));
}

/** Semantic gate before adopting LibreOffice-refreshed bytes. Reject destructive rewrites. */
export async function acceptRefreshedDocxFields(
  binding: DocxEngineBinding,
  original: Uint8Array,
  refreshed: Uint8Array,
): Promise<FieldRefreshAcceptance> {
  if (!binding.inspectDocxFields) {
    return { ok: false, reason: "field inspection unavailable" };
  }

  const beforeParts = new Set(protectedPackageParts(listDocxPartNames(original)));
  if (beforeParts.size) {
    const afterParts = new Set(protectedPackageParts(listDocxPartNames(refreshed)));
    for (const part of beforeParts) {
      if (!afterParts.has(part)) {
        return { ok: false, reason: `package part lost: ${part}` };
      }
    }
  }

  let beforeFields;
  let afterFields;
  try {
    beforeFields = await binding.inspectDocxFields(original);
    afterFields = await binding.inspectDocxFields(refreshed);
  } catch {
    return { ok: false, reason: "field inspection failed" };
  }
  if (!beforeFields.ok || !afterFields.ok) {
    return { ok: false, reason: "field inspection failed" };
  }

  const beforeToc = beforeFields.fields.filter((field) => field.kind === "toc");
  const afterToc = afterFields.fields.filter((field) => field.kind === "toc");
  if (beforeToc.length && !afterToc.length) {
    return { ok: false, reason: "TOC field lost" };
  }
  if (afterToc.some((field) => field.structure === "malformed")) {
    return { ok: false, reason: "TOC field malformed after refresh" };
  }
  if (afterToc.some(tocNeedsExternalRefresh)) {
    return { ok: false, reason: "TOC still refresh_required after provider" };
  }

  const beforeUnknown = beforeFields.fields.filter((field) => field.kind === "unknown").length;
  const afterUnknown = afterFields.fields.filter((field) => field.kind === "unknown").length;
  if (afterUnknown < beforeUnknown) {
    return { ok: false, reason: "unknown fields lost" };
  }

  if (binding.inspectDocxComments) {
    const [beforeComments, afterComments] = await Promise.all([
      binding.inspectDocxComments(original).catch(() => null),
      binding.inspectDocxComments(refreshed).catch(() => null),
    ]);
    if (beforeComments?.ok && afterComments?.ok && afterComments.total < beforeComments.total) {
      return { ok: false, reason: "comments changed" };
    }
  }

  if (binding.inspectDocxTrackedChanges) {
    const [beforeRevisions, afterRevisions] = await Promise.all([
      binding.inspectDocxTrackedChanges(original).catch(() => null),
      binding.inspectDocxTrackedChanges(refreshed).catch(() => null),
    ]);
    if (beforeRevisions?.ok && afterRevisions?.ok) {
      const beforeCount = beforeRevisions.insertionCount + beforeRevisions.deletionCount;
      const afterCount = afterRevisions.insertionCount + afterRevisions.deletionCount;
      if (afterCount < beforeCount) {
        return { ok: false, reason: "revisions changed" };
      }
    }
  }

  // Preserve headings that existed before refresh.
  try {
    const [beforeOverview, afterOverview] = await Promise.all([
      binding.inspectDocx(original, { focus: { kind: "overview" } }),
      binding.inspectDocx(refreshed, { focus: { kind: "overview" } }),
    ]);
    if (beforeOverview.ok && afterOverview.ok && beforeOverview.overview && afterOverview.overview) {
      if (afterOverview.overview.sectionCount < beforeOverview.overview.sectionCount) {
        return { ok: false, reason: "sections lost" };
      }
    }
    const beforeBlocks = await binding.inspectDocx(original, { focus: { kind: "body_blocks", offset: 0, limit: 100 } });
    const headings = (beforeBlocks.bodyBlocks?.items ?? [])
      .filter((block) => (block.headingLevel ?? 0) >= 1)
      .map((block) => (block.text ?? "").trim())
      .filter(Boolean)
      .slice(0, 12);
    for (const heading of headings) {
      const found = await binding.findDocxText(refreshed, { text: heading });
      if (!found.ok || found.matchCount < 1) {
        return { ok: false, reason: `heading lost: ${heading.slice(0, 40)}` };
      }
    }
  } catch {
    return { ok: false, reason: "structure inspection failed" };
  }

  const pageFields = afterFields.fields.filter((field) => field.kind === "page" || field.kind === "numPages").length;
  return { ok: true, tocPopulated: afterToc.length > 0, pageFields };
}

export function formatFieldRefreshLog(
  result: DocxFieldRefreshResult,
  acceptance?: FieldRefreshAcceptance,
): string {
  if (result.status === "unavailable") return "field refresh unavailable";
  if (result.status === "failed") {
    return `field refresh ✗ ${result.detail ?? result.warnings[0] ?? "failed"}`;
  }
  if (acceptance && !acceptance.ok) {
    return `field refresh ✗ preservation check: ${acceptance.reason ?? "rejected"}`;
  }
  const toc = acceptance?.tocPopulated ? "toc=1" : "toc=0";
  const pages = `pageFields=${acceptance?.pageFields ?? 0}`;
  return `field refresh libreoffice ✓ ${result.durationMs}ms ${toc} ${pages}`;
}

/** Refresh + accept, or keep original bytes. Never throws for provider failures. */
export async function refreshWorkingDocxFields(
  binding: DocxEngineBinding,
  bytes: Uint8Array,
): Promise<{
  bytes: Uint8Array;
  result: DocxFieldRefreshResult;
  accepted: boolean;
  acceptance?: FieldRefreshAcceptance;
}> {
  if (!binding.inspectDocxFields) {
    return {
      bytes,
      accepted: false,
      result: {
        status: "unavailable",
        provider: "libreoffice-macro",
        durationMs: 0,
        warnings: ["Field inspection unavailable"],
      },
    };
  }

  let inspection;
  try {
    inspection = await binding.inspectDocxFields(bytes);
  } catch {
    return {
      bytes,
      accepted: false,
      result: {
        status: "failed",
        provider: "libreoffice-macro",
        durationMs: 0,
        warnings: ["Could not inspect fields before refresh"],
      },
    };
  }
  if (!inspection.ok || !fieldsNeedExternalRefresh(inspection.fields)) {
    return {
      bytes,
      accepted: false,
      result: {
        status: "unavailable",
        provider: "libreoffice-macro",
        durationMs: 0,
        warnings: [],
        detail: "no refreshable fields",
      },
    };
  }

  const result = await refreshDocxFields(bytes);
  if (result.status !== "refreshed" || !result.bytes) {
    return { bytes, result, accepted: false };
  }

  const acceptance = await acceptRefreshedDocxFields(binding, bytes, result.bytes);
  if (!acceptance.ok) {
    return { bytes, result, accepted: false, acceptance };
  }
  return { bytes: result.bytes, result, accepted: true, acceptance };
}
