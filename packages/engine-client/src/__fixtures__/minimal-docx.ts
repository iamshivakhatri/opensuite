/**
 * Minimal in-memory DOCX builder for adapter tests (no temp files required).
 * Mirrors the opensuite-node binding fixture shape.
 */

const OFFICE_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
const WORD_NS =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipDocxFiles(files: Array<[string, string]>): Buffer {
  let offset = 0;
  const local: Buffer[] = [];
  const central: Buffer[] = [];

  for (const [name, text] of files) {
    const filename = Buffer.from(name);
    const content = Buffer.from(text);
    const checksum = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, content);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(content.length, 20);
    directory.writeUInt32LE(content.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + content.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

function packDocumentXml(bodyInner: string): Buffer {
  return zipDocxFiles([
    [
      "[Content_Types].xml",
      '<Types><Default Extension="xml" ContentType="application/xml"/></Types>',
    ],
    [
      "_rels/.rels",
      `<Relationships><Relationship Id="rId1" Type="${OFFICE_REL}" Target="word/document.xml"/></Relationships>`,
    ],
    [
      "word/document.xml",
      `<w:document xmlns:w="${WORD_NS}"><w:body>${bodyInner}</w:body></w:document>`,
    ],
  ]);
}

/** Build a tiny valid DOCX Buffer containing the given body paragraph texts. */
export function buildMinimalDocx(paragraphTexts: readonly string[]): Buffer {
  const body = paragraphTexts
    .map(
      (text) =>
        `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`,
    )
    .join("");
  return packDocumentXml(body);
}

/**
 * Simple rectangular Name/Role table used by table mutation lifecycle tests.
 * When `withGrid` is true, includes explicit w:tblGrid (required for column insert).
 */
export function buildNameRoleTableDocx(
  options: { readonly withGrid?: boolean } = {},
): Buffer {
  const rows: readonly (readonly string[])[] = [
    ["Name", "Role"],
    ["Alice", "CEO"],
    ["Bob", "CTO"],
  ];
  return buildTableDocx(rows, options);
}

/**
 * Executive Role / Meeting Access Level table with a blank trailing row —
 * used for artifact-local cell-handle mutation proofs.
 */
export function buildExecutiveAccessTableDocx(
  options: { readonly withGrid?: boolean } = {},
): Buffer {
  const rows: readonly (readonly (string | null)[])[] = [
    ["Executive Role", "Meeting Access Level"],
    ["CFO", "Full access"],
    ["CTO", "Full access"],
    ["COO", "Limited"],
    ["CISO", "Limited"],
    ["General Counsel", "Full access"],
    ["CHRO", "Limited"],
    [null, null],
  ];
  return buildTableDocx(rows, options);
}

function buildTableDocx(
  rows: readonly (readonly (string | null)[])[],
  options: { readonly withGrid?: boolean } = {},
): Buffer {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const colWidth = 2400;
  if (options.withGrid) {
    const grid = `<w:tblGrid>${Array.from(
      { length: width },
      () => `<w:gridCol w:w="${colWidth}"/>`,
    ).join("")}</w:tblGrid>`;
    const table = `<w:tbl>${grid}${rows
      .map(
        (row) =>
          `<w:tr>${row
            .map((cell) => cellXml(cell, colWidth))
            .join("")}</w:tr>`,
      )
      .join("")}</w:tbl>`;
    return packDocumentXml(table);
  }
  return packDocumentXml(
    `<w:tbl>${rows
      .map(
        (row) =>
          `<w:tr>${row.map((cell) => cellXml(cell)).join("")}</w:tr>`,
      )
      .join("")}</w:tbl>`,
  );
}

function cellXml(text: string | null, widthDxa?: number): string {
  const tcPr =
    widthDxa !== undefined
      ? `<w:tcPr><w:tcW w:w="${widthDxa}" w:type="dxa"/></w:tcPr>`
      : "";
  if (text === null || text === "") {
    return `<w:tc>${tcPr}<w:p/></w:tc>`;
  }
  return `<w:tc>${tcPr}<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p></w:tc>`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
