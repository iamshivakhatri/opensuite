/**
 * Execution-backed reachability audit for published @opensuitehq/engine@0.1.8.
 * Inventories every native operation, classifies the product path, and exercises it.
 * Requires OPENSUITE_ENGINE_PATH unset (npm binary only).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  bindDocxDocument,
  buildMinimalDocx,
  buildNameRoleTableDocx,
  createNapiDocxEngineBinding,
  describeNativeEngine,
  docxOperationDefinitions,
} from "@opensuite/engine-client";

import { builtInTools } from "../agent/capabilities/definitions/built-in.js";
import { createToolSurface } from "../agent/capabilities/runtime/tool-surface.js";
import {
  createDocumentTools,
  HIDDEN_BINARY_MUTATION_CAPABILITIES,
} from "../agent/document-tools.js";
import { createPrimaryDocxTools } from "../agent/docx-tools.js";
import { createImageAssetTools } from "../agent/image-asset-tools.js";
import { verifyDocumentUpdate } from "../agent/document-verification.js";

const call = { toolCallId: "reachability", messages: [], context: undefined as never };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7WQAAAABJRU5ErkJggg==",
  "base64",
);

type Category =
  | "Direct agent"
  | "Composed agent"
  | "Internal application"
  | "Missing integration"
  | "Engine unsupported";

type Row = {
  id: string;
  kind: string;
  category: Category;
  path: string;
  discovered: boolean | null;
  loaded: boolean | null;
  invoked: boolean;
  result: "PASS" | "FAIL" | "UNVERIFIED" | "INTENTIONALLY INTERNAL" | "UNSUPPORTED";
  evidence: string;
};

function zipDocx(files: Array<[string, string]>): Buffer {
  const crc32 = (bytes: Uint8Array) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
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

function contentControlDocx(): Uint8Array {
  const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
  const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
  const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument";
  const WORD_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const sdt =
    `<w:sdt><w:sdtPr><w:alias w:val="Title"/><w:tag w:val="title"/><w:id w:val="1"/><w:text/></w:sdtPr>` +
    `<w:sdtContent><w:p><w:r><w:t>Placeholder</w:t></w:r></w:p></w:sdtContent></w:sdt>`;
  const styles =
    `<?xml version="1.0"?><w:styles xmlns:w="${WORD_NS}">` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
  return new Uint8Array(
    zipDocx([
      [
        "[Content_Types].xml",
        `<?xml version="1.0"?><Types xmlns="${CT_NS}">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}">` +
          `<Relationship Id="rId1" Type="${OFFICE_REL}" Target="word/document.xml"/></Relationships>`,
      ],
      [
        "word/_rels/document.xml.rels",
        `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}">` +
          `<Relationship Id="rId1" Type="${WORD_REL}/styles" Target="styles.xml"/></Relationships>`,
      ],
      ["word/styles.xml", styles],
      [
        "word/document.xml",
        `<w:document xmlns:w="${WORD_NS}"><w:body>${sdt}<w:sectPr/></w:body></w:document>`,
      ],
    ]),
  );
}

function classify(id: string, kind: string, tools: Record<string, unknown>): { category: Category; path: string } {
  const special: Record<string, { category: Category; path: string }> = {
    inspect: { category: "Direct agent", path: "document.inspect" },
    find_text: { category: "Direct agent", path: "document.find" },
    body_blocks: { category: "Composed agent", path: "document.inspect kind=body_blocks" },
    inspect_context: { category: "Composed agent", path: "document.inspect kind=context" },
    layout_snapshot: { category: "Direct agent", path: "document.inspect_layout" },
    create_blank_docx: {
      category: "Internal application",
      path: "workspace.create_blank_document → createBlankDocx",
    },
    insert_picture: {
      category: "Composed agent",
      path: "document.insert_image_asset → insert_picture",
    },
    replace_picture: {
      category: "Composed agent",
      path: "document.replace_image_asset → replace_picture",
    },
    semantic_table_cell_targets: {
      category: "Composed agent",
      path: "semantic selectors on set_table_cells_* / set_table_cell_shading",
    },
    semantic_table_row_deletion: {
      category: "Composed agent",
      path: "semantic label selectors on delete_table_row",
    },
  };
  if (special[id]) return special[id]!;
  const toolName = `document.${id}`;
  if (tools[toolName]) return { category: "Direct agent", path: toolName };
  if (kind === "create") {
    return { category: "Internal application", path: "workspace.create_blank_document" };
  }
  return { category: "Missing integration", path: "" };
}

async function requireOk(
  label: string,
  result: {
    ok?: boolean;
    reasonCode?: string;
    diagnostics?: readonly { message?: string }[];
  } | undefined,
): Promise<void> {
  assert.equal(
    result?.ok,
    true,
    `${label} failed: ${result?.reasonCode ?? "unknown"} ${result?.diagnostics?.[0]?.message ?? ""}`,
  );
}

test("v0.1.8 native inventory is fully reachable through OpenSuite paths", async () => {
  assert.equal(process.env.OPENSUITE_ENGINE_PATH, undefined, "OPENSUITE_ENGINE_PATH must be unset");
  const binding = await createNapiDocxEngineBinding();
  const identity = await describeNativeEngine(binding);
  assert.equal(identity.fromEnv, false);
  assert.equal(identity.loaderOverrides.length, 0);
  assert.equal(binding.getDocxCapabilities().engineVersion, "0.1.8");
  assert.equal(binding.getDocxCapabilities().protocolVersion, 1);

  const caps = binding.getDocxCapabilities();
  const fmt = caps.formats.find((f) => f.format === "docx")!;
  const operations = docxOperationDefinitions(caps);
  assert.equal(operations.length, 63);
  assert.equal(fmt.capabilities.length, 65);

  const seed = new Uint8Array(buildMinimalDocx(["Reachability seed.", "Keep this paragraph."]));
  const bound = bindDocxDocument({ binding, bytes: seed, versionId: "v1" });
  const documentTools = createDocumentTools(bound);
  const imageTools = createImageAssetTools({
    assets: {
      listImages: async () => ({
        items: [{
          assetId: "asset-1",
          contentType: "image/png",
          sizeBytes: PNG.length,
          width: 1,
          height: 1,
          createdAt: new Date(0).toISOString(),
        }],
        offset: 0,
        limit: 20,
      }),
      readBytes: async () => ({ bytes: PNG, contentType: "image/png" }),
    },
    ownerUserId: "user",
    workspaceId: "workspace",
    mutate: (capability, operation) => bound.mutate(capability, operation),
    canInsert: true,
    canReplace: true,
  });
  const tools = { ...documentTools, ...imageTools };
  const builtinByTool = new Map(
    builtInTools.filter((t) => t.toolName).map((t) => [t.toolName!, t]),
  );

  const inventory: Array<{ id: string; kind: string; nodeExport: string | null }> = [
    ...operations.map((op) => ({ id: op.id, kind: op.kind, nodeExport: op.nodeExport })),
    { id: "semantic_table_cell_targets", kind: "flag", nodeExport: null },
    { id: "semantic_table_row_deletion", kind: "flag", nodeExport: null },
  ];

  const rows: Row[] = [];
  for (const item of inventory) {
    const { category, path } = classify(item.id, item.kind, tools);
    let discovered: boolean | null = null;
    let loaded: boolean | null = null;
    const toolPath = path.split("→")[0]!.trim().split(" ")[0]!;
    if (category === "Direct agent" || category === "Composed agent") {
      const surface = createToolSurface(tools);
      const meta = builtinByTool.get(toolPath);
      if (meta?.projection === "always") {
        discovered = true;
        loaded = !!surface.initialTools[toolPath] || !!tools[toolPath];
      } else {
        const loadId = meta?.parentId ?? meta?.id ?? toolPath;
        const load = surface.session.load([loadId]);
        discovered = load.ok;
        loaded = load.ok && !!surface.projectTools()[toolPath];
        if (!loaded) {
          const more = surface.session.load(["document.more_operations"]);
          loaded = more.ok && !!surface.projectTools()[toolPath];
          discovered = discovered || more.ok;
        }
      }
    }
    rows.push({
      id: item.id,
      kind: item.kind,
      category,
      path,
      discovered,
      loaded,
      invoked: false,
      result: "UNVERIFIED",
      evidence: "",
    });
  }

  const missing = rows.filter((r) => r.category === "Missing integration");
  assert.deepEqual(
    missing.map((r) => r.id),
    [],
    `missing integrations: ${missing.map((r) => r.id).join(", ")}`,
  );
  for (const hidden of HIDDEN_BINARY_MUTATION_CAPABILITIES) {
    assert.equal(documentTools[`document.${hidden}`], undefined);
    assert.ok(tools[`document.${hidden === "insert_picture" ? "insert_image_asset" : "replace_image_asset"}`]);
  }

  const mark = (id: string, result: Row["result"], evidence: string, invoked = true) => {
    const row = rows.find((r) => r.id === id);
    assert.ok(row, `unknown inventory id ${id}`);
    row.invoked = invoked;
    row.result = result;
    row.evidence = evidence;
  };

  // --- Reads ---
  const overview = await bound.inspect({ focus: { kind: "overview" } });
  assert.ok(overview);
  mark("inspect", "PASS", "document.inspect overview");

  const blocks = await bound.inspect({ focus: { kind: "body_blocks" } });
  assert.ok(blocks.bodyBlocks?.items?.length);
  mark("body_blocks", "PASS", "document.inspect body_blocks");

  const context = await bound.inspect({
    focus: { kind: "context", text: "Reachability seed.", before: 0, after: 1 },
  });
  assert.ok(context);
  mark("inspect_context", "PASS", "document.inspect context");

  const found = await bound.find({ text: "Reachability seed." });
  assert.ok(found.matches?.length);
  mark("find_text", "PASS", "document.find");

  const styleSnap = await tools["document.style_snapshot"]!.execute!({}, call);
  assert.ok(styleSnap);
  mark("style_snapshot", "PASS", "document.style_snapshot");

  // --- Text / paragraphs ---
  await requireOk(
    "replace_text",
    await bound.mutate("replace_text", {
      target: { text: "Reachability seed." },
      expectedCurrentText: "Reachability seed.",
      replacement: "Reachability alpha.",
    }),
  );
  mark("replace_text", "PASS", "mutate + find");

  await requireOk(
    "insert_paragraph",
    await bound.mutate("insert_paragraph", { text: "Inserted one.", placement: { kind: "end" } }),
  );
  mark("insert_paragraph", "PASS", "mutate");

  await requireOk(
    "insert_paragraphs",
    await bound.mutate("insert_paragraphs", {
      texts: ["List A", "List B"],
      placement: { kind: "end" },
    }),
  );
  mark("insert_paragraphs", "PASS", "mutate");

  await requireOk(
    "set_paragraph_style",
    await bound.mutate("set_paragraph_style", { target: { text: "Inserted one." }, style: "Heading 1" }),
  );
  mark("set_paragraph_style", "PASS", "mutate");

  await requireOk(
    "set_paragraph_formatting",
    await bound.mutate("set_paragraph_formatting", { target: { text: "List A" }, alignment: "center" }),
  );
  mark("set_paragraph_formatting", "PASS", "mutate");

  await requireOk(
    "set_text_formatting",
    await bound.mutate("set_text_formatting", { target: { text: "List B" }, bold: true }),
  );
  mark("set_text_formatting", "PASS", "mutate");

  await requireOk(
    "set_paragraphs_list",
    await bound.mutate("set_paragraphs_list", {
      targets: [{ text: "List A" }, { text: "List B" }],
      kind: "bullet",
      level: 0,
    }),
  );
  mark("set_paragraphs_list", "PASS", "mutate");

  await requireOk(
    "prep_hyperlink",
    await bound.mutate("insert_paragraph", { text: "Link target text.", placement: { kind: "end" } }),
  );
  await requireOk(
    "set_hyperlink",
    await bound.mutate("set_hyperlink", {
      target: { text: "Link target text." },
      url: "https://example.com",
    }),
  );
  mark("set_hyperlink", "PASS", "mutate");

  await requireOk(
    "delete_paragraph",
    await bound.mutate("delete_paragraph", { target: { text: "Keep this paragraph." } }),
  );
  mark("delete_paragraph", "PASS", "mutate");

  // --- Tables (fresh doc with grid for column ops) ---
  const tableDoc = bindDocxDocument({
    binding,
    bytes: new Uint8Array(buildNameRoleTableDocx({ withGrid: true })),
    versionId: "t1",
  });
  // create_table on a fresh blank, then continue structural edits on the Name/Role fixture
  const createTableDoc = bindDocxDocument({
    binding,
    bytes: binding.createBlankDocx(),
    versionId: "ct1",
  });
  await requireOk(
    "create_table",
    await createTableDoc.mutate("create_table", {
      rows: [["H1", "H2"], ["a", "b"]],
      placement: { kind: "end" },
    }),
  );
  mark("create_table", "PASS", "mutate on blank");

  const table = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "insert_table_row",
    await tableDoc.mutate("insert_table_row", {
      table: { handle: table.handle },
      after: { firstCellText: "Alice" },
      cells: ["Carol", "CFO"],
    }),
  );
  mark("insert_table_row", "PASS", "mutate");

  const table2 = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "insert_table_rows",
    await tableDoc.mutate("insert_table_rows", {
      table: { handle: table2.handle },
      after: { firstCellText: "Carol" },
      rows: [["Dan", "COO"]],
    }),
  );
  mark("insert_table_rows", "PASS", "mutate");

  const table3 = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "set_table_cells_text",
    await tableDoc.mutate("set_table_cells_text", {
      table: { handle: table3.handle, headerCells: ["Name", "Role"] },
      updates: [
        {
          target: { row: { kind: "label", text: "Alice" }, column: { kind: "header", text: "Role" } },
          expectedCurrentText: "CEO",
          replacement: "Chief",
        },
      ],
    }),
  );
  mark("set_table_cells_text", "PASS", "semantic cell target");
  mark("semantic_table_cell_targets", "PASS", "used label/header selectors");

  const table4 = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "set_table_cell_shading",
    await tableDoc.mutate("set_table_cell_shading", {
      table: { handle: table4.handle },
      updates: [
        {
          target: { row: { kind: "header" }, column: { kind: "first" } },
          fill: "D9E2F3",
        },
      ],
    }),
  );
  mark("set_table_cell_shading", "PASS", "mutate");

  await requireOk(
    "set_table_cells_formatting",
    await tableDoc.mutate("set_table_cells_formatting", {
      table: { handle: table4.handle },
      updates: [
        {
          target: { row: { kind: "header" }, column: { kind: "first" } },
          textFormatting: { bold: true },
        },
      ],
    }),
  );
  mark("set_table_cells_formatting", "PASS", "mutate");

  await requireOk(
    "set_table_formatting",
    await tableDoc.mutate("set_table_formatting", {
      table: { handle: table4.handle },
      alignment: "center",
    }),
  );
  mark("set_table_formatting", "PASS", "mutate");

  await requireOk(
    "set_table_column_widths",
    await tableDoc.mutate("set_table_column_widths", {
      table: { handle: table4.handle },
      widthsTwips: [2400, 2400],
    }),
  );
  mark("set_table_column_widths", "PASS", "mutate");

  await requireOk(
    "insert_table_column",
    await tableDoc.mutate("insert_table_column", {
      table: { handle: table4.handle },
      afterColumnHeader: "Role",
      header: "Dept",
      cells: ["X", "Y", "Z", "W"],
    }),
  );
  mark("insert_table_column", "PASS", "mutate");

  const table5 = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "delete_table_column",
    await tableDoc.mutate("delete_table_column", {
      table: { handle: table5.handle },
      columnHeader: "Dept",
    }),
  );
  mark("delete_table_column", "PASS", "mutate");

  const table6 = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "delete_table_row",
    await tableDoc.mutate("delete_table_row", {
      table: { handle: table6.handle },
      row: { kind: "label", text: "Dan" },
    }),
  );
  mark("delete_table_row", "PASS", "semantic row deletion");
  mark("semantic_table_row_deletion", "PASS", "label selector");

  const table7 = (await tableDoc.inspect({ focus: { kind: "tables" } })).tables!.items[0]!;
  await requireOk(
    "delete_table",
    await tableDoc.mutate("delete_table", { table: { handle: table7.handle } }),
  );
  mark("delete_table", "PASS", "mutate");

  // --- Styles (fresh blank) ---
  const styleDoc = bindDocxDocument({ binding, bytes: binding.createBlankDocx(), versionId: "s1" });
  await requireOk(
    "create_style",
    await styleDoc.mutate("create_style", {
      styleId: "AuditStyle",
      name: "Audit Style",
      styleType: "paragraph",
      basedOn: "Normal",
      bold: true,
    }),
  );
  mark("create_style", "PASS", "mutate");

  await requireOk(
    "update_style",
    await styleDoc.mutate("update_style", {
      styleId: "AuditStyle",
      styleType: "paragraph",
      italic: true,
    }),
  );
  mark("update_style", "PASS", "mutate");

  // --- Sections / layout / headers (fresh blank with one paragraph) ---
  const layoutDoc = bindDocxDocument({ binding, bytes: binding.createBlankDocx(), versionId: "l1" });
  await requireOk(
    "prep_layout",
    await layoutDoc.mutate("insert_paragraph", { text: "Section body.", placement: { kind: "end" } }),
  );
  const layout = await layoutDoc.readOperation!("layout_snapshot", {});
  assert.ok(layout);
  mark("layout_snapshot", "PASS", "document.inspect_layout / readOperation");

  // set_page_setup / set_header_footer_text / set_page_number require a single terminal section
  await requireOk(
    "set_page_setup",
    await layoutDoc.mutate("set_page_setup", { paperSize: "letter", orientation: "portrait" }),
  );
  mark("set_page_setup", "PASS", "mutate");

  await requireOk(
    "set_header_footer_text",
    await layoutDoc.mutate("set_header_footer_text", { kind: "footer", text: "Footer line" }),
  );
  mark("set_header_footer_text", "PASS", "mutate");

  await requireOk(
    "set_page_number",
    await layoutDoc.mutate("set_page_number", { kind: "footer", alignment: "center" }),
  );
  mark("set_page_number", "PASS", "mutate");

  await requireOk(
    "insert_section_break",
    await layoutDoc.mutate("insert_section_break", { placement: { kind: "end" }, breakType: "nextPage" }),
  );
  mark("insert_section_break", "PASS", "mutate");

  const sections = await layoutDoc.readOperation!("inspect_sections", {});
  assert.ok(sections);
  mark("inspect_sections", "PASS", "document.inspect_sections");
  const sectionHandle = (sections as { sections: { handle: string }[] }).sections[0]!.handle;

  await requireOk(
    "set_section_properties",
    await layoutDoc.mutate("set_section_properties", {
      handle: sectionHandle,
      pageSetup: { orientation: "portrait" },
    }),
  );
  mark("set_section_properties", "PASS", "mutate");

  const sections2 = (await layoutDoc.readOperation!("inspect_sections", {})) as {
    sections: { handle: string }[];
  };
  await requireOk(
    "set_section_header_footer",
    await layoutDoc.mutate("set_section_header_footer", {
      handle: sections2.sections[0]!.handle,
      kind: "header",
      variant: "default",
      action: "text",
      text: "Header text",
    }),
  );
  mark("set_section_header_footer", "PASS", "mutate");

  await requireOk(
    "set_odd_even_headers",
    await layoutDoc.mutate("set_odd_even_headers", { enabled: false }),
  );
  mark("set_odd_even_headers", "PASS", "mutate");

  await requireOk(
    "insert_page_break",
    await layoutDoc.mutate("insert_page_break", { placement: { kind: "end" } }),
  );
  mark("insert_page_break", "PASS", "mutate");

  const body = await layoutDoc.inspect({ focus: { kind: "body_blocks", limit: 100 } });
  const pageBreak = body.bodyBlocks?.items?.find((b) => b.kind === "page_break");
  if (pageBreak?.handle) {
    await requireOk(
      "delete_page_break",
      await layoutDoc.mutate("delete_page_break", { handle: pageBreak.handle }),
    );
    mark("delete_page_break", "PASS", "mutate");
  } else {
    mark("delete_page_break", "FAIL", "page break handle not found after insert");
  }

  // --- Fields / TOC ---
  const fieldDoc = bindDocxDocument({ binding, bytes: binding.createBlankDocx(), versionId: "f1" });
  await requireOk(
    "prep_fields",
    await fieldDoc.mutate("insert_paragraph", { text: "Heading One", placement: { kind: "end" } }),
  );
  await requireOk(
    "prep_fields_style",
    await fieldDoc.mutate("set_paragraph_style", { target: { text: "Heading One" }, style: "Heading 1" }),
  );
  await requireOk(
    "insert_toc",
    await fieldDoc.mutate("insert_toc", { placement: { kind: "start" }, title: "Contents" }),
  );
  mark("insert_toc", "PASS", "mutate");

  await requireOk(
    "insert_fields",
    await fieldDoc.mutate("insert_fields", {
      location: "footer",
      content: [{ kind: "page" }, { kind: "text", text: " of " }, { kind: "numPages" }],
    }),
  );
  mark("insert_fields", "PASS", "mutate");

  const fields = await fieldDoc.readOperation!("inspect_fields", {});
  assert.ok(fields);
  mark("inspect_fields", "PASS", "document.inspect_fields");

  // --- Comments ---
  const commentDoc = bindDocxDocument({
    binding,
    bytes: new Uint8Array(buildMinimalDocx(["Revenue increased 12% in Q3."])),
    versionId: "c1",
  });
  await requireOk(
    "add_comment",
    await commentDoc.mutate("add_comment", {
      target: { text: "12%" },
      text: "Check this.",
      author: "Auditor",
    }),
  );
  mark("add_comment", "PASS", "mutate");
  const comments = (await commentDoc.readOperation!("inspect_comments", {})) as {
    comments: { handle: string; text: string }[];
    total: number;
  };
  assert.ok(comments.total >= 1);
  mark("inspect_comments", "PASS", "document.inspect_comments");
  await requireOk(
    "update_comment",
    await commentDoc.mutate("update_comment", { handle: comments.comments[0]!.handle, text: "Updated note." }),
  );
  mark("update_comment", "PASS", "mutate");
  const comments2 = (await commentDoc.readOperation!("inspect_comments", {})) as {
    comments: { handle: string }[];
  };
  await requireOk(
    "delete_comment",
    await commentDoc.mutate("delete_comment", { handle: comments2.comments[0]!.handle }),
  );
  mark("delete_comment", "PASS", "mutate");

  // --- Revisions ---
  const utc = "2026-10-14T12:00:00.000Z";
  const revDoc = bindDocxDocument({
    binding,
    bytes: new Uint8Array(buildMinimalDocx(["Revenue was steady.", "Delete this line."])),
    versionId: "r1",
  });
  await requireOk(
    "insert_tracked_text",
    await revDoc.mutate("insert_tracked_text", {
      target: { text: "Revenue was steady." },
      position: "after",
      text: " TRACKED",
      author: "Auditor",
      date: utc,
    }),
  );
  mark("insert_tracked_text", "PASS", "mutate");

  await requireOk(
    "delete_tracked_text",
    await revDoc.mutate("delete_tracked_text", {
      target: { text: "Delete this line." },
      author: "Auditor",
      date: utc,
    }),
  );
  mark("delete_tracked_text", "PASS", "mutate");

  await requireOk(
    "prep_tracked_replace",
    await revDoc.mutate("insert_paragraph", { text: "Replace me tracked.", placement: { kind: "end" } }),
  );
  await requireOk(
    "replace_text_with_tracked_change",
    await revDoc.mutate("replace_text_with_tracked_change", {
      target: { text: "Replace me tracked." },
      replacement: "Replaced tracked.",
      author: "Auditor",
      date: utc,
    }),
  );
  mark("replace_text_with_tracked_change", "PASS", "mutate");

  const revisions = (await revDoc.readOperation!("inspect_tracked_changes", {})) as {
    revisions: { handle: string; kind: string }[];
  };
  assert.ok(revisions.revisions?.length);
  mark("inspect_tracked_changes", "PASS", "document.inspect_tracked_changes");

  const insertion = revisions.revisions.find((r) => r.kind === "insertion") ?? revisions.revisions[0]!;
  await requireOk(
    "accept_revision",
    await revDoc.mutate("accept_revision", { handle: insertion.handle }),
  );
  mark("accept_revision", "PASS", "mutate");

  const revisions2 = (await revDoc.readOperation!("inspect_tracked_changes", {})) as {
    revisions: { handle: string; kind: string }[];
  };
  const deletion = revisions2.revisions.find((r) => r.kind === "deletion");
  assert.ok(deletion, "expected a tracked deletion to reject");
  await requireOk(
    "reject_revision",
    await revDoc.mutate("reject_revision", { handle: deletion!.handle }),
  );
  mark("reject_revision", "PASS", "mutate");

  // --- Notes ---
  const noteDoc = bindDocxDocument({
    binding,
    bytes: new Uint8Array(buildMinimalDocx(["Cite this claim."])),
    versionId: "n1",
  });
  await requireOk(
    "insert_note",
    await noteDoc.mutate("insert_note", {
      target: { text: "Cite this claim." },
      kind: "footnote",
      text: "Source note.",
    }),
  );
  mark("insert_note", "PASS", "mutate");
  const notes = (await noteDoc.readOperation!("inspect_notes", {})) as {
    notes: { handle: string; text: string }[];
  };
  assert.ok(notes.notes?.length);
  mark("inspect_notes", "PASS", "document.inspect_notes");
  await requireOk(
    "update_note",
    await noteDoc.mutate("update_note", { handle: notes.notes[0]!.handle, text: "Updated source." }),
  );
  mark("update_note", "PASS", "mutate");
  const notes2 = (await noteDoc.readOperation!("inspect_notes", {})) as { notes: { handle: string }[] };
  await requireOk(
    "delete_note",
    await noteDoc.mutate("delete_note", { handle: notes2.notes[0]!.handle }),
  );
  mark("delete_note", "PASS", "mutate");

  // --- Content control ---
  const ccDoc = bindDocxDocument({ binding, bytes: contentControlDocx(), versionId: "cc1" });
  await requireOk(
    "set_content_control_text",
    await ccDoc.mutate("set_content_control_text", {
      target: { tag: "title" },
      expectedCurrentText: "Placeholder",
      replacement: "Filled Title",
    }),
  );
  const afterCc = await ccDoc.find({ text: "Filled Title" });
  assert.ok(afterCc.matches?.length);
  mark("set_content_control_text", "PASS", "mutate + find Filled Title");

  // --- Images: insert/replace composed + size/layout/delete direct ---
  const imgBase = bindDocxDocument({ binding, bytes: binding.createBlankDocx(), versionId: "img0" });
  const imgAssetTools = createImageAssetTools({
    assets: {
      listImages: async () => ({
        items: [{
          assetId: "asset-1",
          contentType: "image/png",
          sizeBytes: PNG.length,
          width: 1,
          height: 1,
          createdAt: new Date(0).toISOString(),
        }],
        offset: 0,
        limit: 20,
      }),
      readBytes: async () => ({ bytes: PNG, contentType: "image/png" }),
    },
    ownerUserId: "user",
    workspaceId: "workspace",
    mutate: (capability, operation) => imgBase.mutate(capability, operation),
    canInsert: true,
    canReplace: true,
  });
  await requireOk(
    "insert_image_asset",
    (await imgAssetTools["document.insert_image_asset"]!.execute!(
      { assetId: "asset-1", placement: { kind: "end" }, widthEmu: 914400 },
      call,
    )) as { ok?: boolean },
  );
  mark("insert_picture", "PASS", "document.insert_image_asset");

  const layoutAfter = (await imgBase.readOperation!("layout_snapshot", {})) as {
    images: { handle: string }[];
  };
  assert.ok(layoutAfter.images?.length);
  await requireOk(
    "replace_image_asset",
    (await imgAssetTools["document.replace_image_asset"]!.execute!(
      { assetId: "asset-1", handle: layoutAfter.images[0]!.handle },
      call,
    )) as { ok?: boolean },
  );
  mark("replace_picture", "PASS", "document.replace_image_asset");

  const layout2 = (await imgBase.readOperation!("layout_snapshot", {})) as {
    images: { handle: string }[];
  };
  await requireOk(
    "set_picture_size",
    await imgBase.mutate("set_picture_size", {
      handle: layout2.images[0]!.handle,
      widthEmu: 1828800,
    }),
  );
  mark("set_picture_size", "PASS", "mutate");

  const floating = await binding.executeDocxInsertPicture!(binding.createBlankDocx(), {
    imageBytes: PNG,
    placement: { kind: "end" },
    widthEmu: 914400,
    layout: {
      horizontal: { reference: "margin", alignment: "end" },
      vertical: { reference: "paragraph", offsetEmu: 0 },
      wrap: "square",
    },
  });
  assert.equal(floating.result.ok, true);
  const imgDoc = bindDocxDocument({ binding, bytes: floating.output!, versionId: "img1" });
  const imgLayout = (await imgDoc.readOperation!("layout_snapshot", {})) as {
    images: { handle: string; kind?: string }[];
  };
  const anchored = imgLayout.images.find((i) => i.kind === "anchored") ?? imgLayout.images[0]!;
  await requireOk(
    "set_picture_layout",
    await imgDoc.mutate("set_picture_layout", {
      handle: anchored.handle,
      layout: { wrap: "topAndBottom" },
    }),
  );
  mark("set_picture_layout", "PASS", "mutate");

  const imgLayout2 = (await imgDoc.readOperation!("layout_snapshot", {})) as {
    images: { handle: string }[];
  };
  await requireOk(
    "delete_picture",
    await imgDoc.mutate("delete_picture", { handle: imgLayout2.images[0]!.handle }),
  );
  mark("delete_picture", "PASS", "mutate");

  // --- Internal: create blank + OPC/save verification ---
  const blank = binding.createBlankDocx();
  assert.ok(blank.byteLength > 0);
  mark("create_blank_docx", "INTENTIONALLY INTERNAL", "binding.createBlankDocx / workspace.create_blank_document");

  let saved: Uint8Array = Buffer.from(blank);
  const session = await createPrimaryDocxTools({
    binding,
    ownerUserId: "user",
    workspaceId: "workspace",
    documentId: null,
    versionId: null,
    documents: {
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "workspace" }) as never,
      readExactVersionBytes: async () => Buffer.from(saved),
      createBlankDocxDocument: async (input: { name?: string }) => {
        const id = randomUUID();
        saved = Buffer.from(binding.createBlankDocx());
        return {
          document: { id, name: input.name ?? "Audit Blank.docx", format: "docx" },
          version: { id: "v1", versionNumber: 1 },
        } as never;
      },
      appendDocumentVersion: async (input: { bytes: Uint8Array }) => {
        saved = Buffer.from(input.bytes);
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
    } as never,
  });
  assert.ok(session);
  const created = await session.tools["workspace.create_blank_document"]!.execute!(
    { title: "Audit Blank" },
    call,
  );
  assert.ok(created);
  assert.ok(saved.byteLength > 0);
  rows.find((r) => r.id === "create_blank_docx")!.invoked = true;
  rows.find((r) => r.id === "create_blank_docx")!.result = "PASS";
  rows.find((r) => r.id === "create_blank_docx")!.evidence =
    "workspace.create_blank_document → createBlankDocxDocument → createBlankDocx";

  const checks = await verifyDocumentUpdate({
    binding,
    before: Buffer.from(blank),
    after: Buffer.from(saved),
    instruction: "create blank",
    targetAdvanced: true,
    sourcesUnchanged: null,
    created: true,
  });
  assert.ok(Array.isArray(checks));
  assert.ok(checks.some((c) => c.id === "open" && c.status === "pass"));

  // Discovery assertions for Direct agent ops
  for (const row of rows) {
    if (row.category === "Direct agent") {
      assert.equal(row.loaded, true, `${row.id} must be loadable via ${row.path}`);
    }
    if (row.category === "Composed agent" && row.path.startsWith("document.")) {
      assert.equal(row.loaded, true, `${row.id} composed path must load (${row.path})`);
    }
  }

  const unverified = rows.filter((r) => r.result === "UNVERIFIED");
  const failed = rows.filter((r) => r.result === "FAIL");
  assert.deepEqual(
    failed.map((r) => `${r.id}: ${r.evidence}`),
    [],
  );
  assert.deepEqual(
    unverified.map((r) => r.id),
    [],
    `unverified ops: ${unverified.map((r) => r.id).join(", ")}`,
  );

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.category] = (acc[row.category] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  console.info(
    "[reachability]",
    JSON.stringify({
      engine: "0.1.8",
      operations: operations.length,
      flags: 2,
      counts,
      executed: rows.filter((r) => r.invoked).length,
      pass: rows.filter((r) => r.result === "PASS").length,
    }),
  );
  // Machine-readable matrix for docs (stderr-safe one line)
  console.info("[reachability-matrix]", JSON.stringify(rows));
});
