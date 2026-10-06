/**
 * Editor-save field preservation.
 *
 * Casual understands standard `w:` field markup (complexField / fldSimple) and
 * can round-trip it. Engine builds that used a non-`w` prefix were parsed as
 * plain text and dropped on full repack. Normalize before load, prefer selective
 * export, and refuse saves that silently lose field markers.
 */

export type DocxFieldMarkers = {
  readonly fldChar: number;
  readonly fldSimple: number;
  readonly instrText: number;
  readonly tocInstructions: number;
};

const TEXT_PART = /(?:^|\/)(document|header\d*|footer\d*)\.xml$/i;

/** Rewrite legacy engine field prefixes so Casual can model real fields. */
export function normalizeDocxFieldPrefixes(xml: string): string {
  if (!xml.includes("opensuiteField")) return xml;
  return xml
    .replace(/\s*xmlns:opensuiteField="[^"]*"/g, "")
    .replace(/opensuiteField:/g, "w:");
}

export function countFieldMarkersInXml(xml: string): DocxFieldMarkers {
  return {
    // Opening element names only — skip attributes and closing tags.
    fldChar: (xml.match(/<(?!\/)[^:>\s]*:?fldChar\b/g) ?? []).length,
    fldSimple: (xml.match(/<(?!\/)[^:>\s]*:?fldSimple\b/g) ?? []).length,
    instrText: (xml.match(/<(?!\/)[^:>\s]*:?instrText\b/g) ?? []).length,
    tocInstructions: (xml.match(/<(?!\/)[^:>\s]*:?instrText\b[^>]*>[^<]*\bTOC\b/gi) ?? []).length,
  };
}

export function mergeFieldMarkers(
  parts: Iterable<DocxFieldMarkers>,
): DocxFieldMarkers {
  const out = { fldChar: 0, fldSimple: 0, instrText: 0, tocInstructions: 0 };
  for (const part of parts) {
    out.fldChar += part.fldChar;
    out.fldSimple += part.fldSimple;
    out.instrText += part.instrText;
    out.tocInstructions += part.tocInstructions;
  }
  return out;
}

export function fieldMarkerTotal(markers: DocxFieldMarkers): number {
  return markers.fldChar + markers.fldSimple + markers.instrText;
}

/**
 * True when exported bytes lost field structure that existed in the source.
 * Intentional whole-document field deletion is not modeled in the editor yet —
 * refuse rather than silently flatten.
 */
export function editorSaveLostFields(
  before: DocxFieldMarkers,
  after: DocxFieldMarkers,
): boolean {
  if (fieldMarkerTotal(before) === 0) return false;
  if (fieldMarkerTotal(after) < fieldMarkerTotal(before)) return true;
  if (before.tocInstructions > 0 && after.tocInstructions < before.tocInstructions) {
    return true;
  }
  return false;
}

type ZipEntry = {
  name: string;
  data: Uint8Array;
  compression: 0 | 8;
};

function asBlobPart(data: Uint8Array): BlobPart {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // Prefer node:zlib in Node — browser CompressionStream stays for the editor host.
  if (typeof process !== "undefined" && process.versions?.node) {
    const zlib = await import("node:zlib");
    return new Uint8Array(zlib.inflateRawSync(data));
  }
  const stream = new Blob([asBlobPart(data)]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof process !== "undefined" && process.versions?.node) {
    const zlib = await import("node:zlib");
    return new Uint8Array(zlib.deflateRawSync(data));
  }
  const stream = new Blob([asBlobPart(data)]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value, true);
}
function u32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value, true);
}

async function readZipEntries(buffer: ArrayBuffer): Promise<ZipEntry[]> {
  const u8 = new Uint8Array(buffer);
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= u8.length) {
    if (
      u8[offset] !== 0x50 ||
      u8[offset + 1] !== 0x4b ||
      u8[offset + 2] !== 0x03 ||
      u8[offset + 3] !== 0x04
    ) {
      break;
    }
    const view = new DataView(u8.buffer, u8.byteOffset + offset, 30);
    const method = view.getUint16(8, true);
    const compSize = view.getUint32(18, true);
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(u8.subarray(nameStart, nameStart + nameLen));
    const dataStart = nameStart + nameLen + extraLen;
    const compressed = u8.subarray(dataStart, dataStart + compSize);
    let data: Uint8Array;
    let compression: 0 | 8;
    if (method === 0) {
      data = compressed.slice();
      compression = 0;
    } else if (method === 8) {
      data = await inflateRaw(compressed);
      compression = 8;
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    entries.push({ name, data, compression });
    offset = dataStart + compSize;
  }
  if (!entries.length) throw new Error("DOCX archive has no local file entries");
  return entries;
}

async function writeZipEntries(entries: readonly ZipEntry[]): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const payload =
      entry.compression === 8 ? await deflateRaw(entry.data) : entry.data;
    const local = new Uint8Array(30 + nameBytes.length + payload.length);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50);
    u16(localView, 4, 20);
    u16(localView, 6, 0);
    u16(localView, 8, entry.compression);
    u16(localView, 10, 0);
    u16(localView, 12, 0);
    u32(localView, 14, crc32(entry.data));
    u32(localView, 18, payload.length);
    u32(localView, 22, entry.data.length);
    u16(localView, 26, nameBytes.length);
    u16(localView, 28, 0);
    local.set(nameBytes, 30);
    local.set(payload, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, 0);
    u16(centralView, 10, entry.compression);
    u16(centralView, 12, 0);
    u16(centralView, 14, 0);
    u32(centralView, 16, crc32(entry.data));
    u32(centralView, 20, payload.length);
    u32(centralView, 24, entry.data.length);
    u16(centralView, 28, nameBytes.length);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u16(centralView, 36, 0);
    u32(centralView, 38, 0);
    u32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50);
  u16(endView, 4, 0);
  u16(endView, 6, 0);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  u32(endView, 12, centralSize);
  u32(endView, 16, offset);
  u16(endView, 20, 0);

  const total =
    locals.reduce((sum, part) => sum + part.length, 0) + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of locals) {
    out.set(part, at);
    at += part.length;
  }
  for (const part of centrals) {
    out.set(part, at);
    at += part.length;
  }
  out.set(end, at);
  return out.buffer;
}

/** Normalize legacy field prefixes inside DOCX XML parts. */
export async function prepareDocxForEditor(
  buffer: ArrayBuffer,
): Promise<ArrayBuffer> {
  const entries = await readZipEntries(buffer);
  for (const entry of entries) {
    if (!TEXT_PART.test(entry.name)) continue;
    const xml = new TextDecoder().decode(entry.data);
    const next = normalizeDocxFieldPrefixes(xml);
    if (next !== xml) {
      entry.data = new TextEncoder().encode(next);
      entry.compression = 8;
    }
  }
  // Always rewrite so Casual keeps a stable ArrayBuffer (Node Buffer pool
  // slices can be reused/detached across later allocations).
  return writeZipEntries(entries);
}

/** Count field markers across main document / header / footer parts. */
export async function countDocxFieldMarkers(
  buffer: ArrayBuffer,
): Promise<DocxFieldMarkers> {
  const entries = await readZipEntries(buffer);
  const parts: DocxFieldMarkers[] = [];
  for (const entry of entries) {
    if (!TEXT_PART.test(entry.name)) continue;
    parts.push(countFieldMarkersInXml(new TextDecoder().decode(entry.data)));
  }
  return mergeFieldMarkers(parts);
}

/**
 * Validate editor export against the buffer that was loaded into Casual.
 * Throws when field structure would be silently destroyed.
 */
export async function assertEditorFieldsPreserved(
  original: ArrayBuffer,
  exported: ArrayBuffer,
): Promise<void> {
  const before = await countDocxFieldMarkers(original);
  const after = await countDocxFieldMarkers(exported);
  if (editorSaveLostFields(before, after)) {
    throw new Error(
      "Save refused: Word fields (for example TOC/PAGE) would be removed. Edit ordinary text only, or remove the field intentionally in a Word-compatible editor.",
    );
  }
}
