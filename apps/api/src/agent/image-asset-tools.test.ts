import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  type DocxFloatingImageLayout,
  type DocxLayoutSnapshot,
} from "@opensuite/engine-client";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";
import { createPrimaryDocxTools } from "./docx-tools.js";
import {
  createImageAssetTools,
  resolveOwnedEngineImage,
} from "./image-asset-tools.js";
import { WorkspaceAssetError } from "../workspace-brand/assets.js";

const pngA = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7WQAAAABJRU5ErkJggg==",
  "base64",
);
const pngB = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC",
  "base64",
);
const call = { toolCallId: "image-asset", messages: [], context: undefined as never };

function schemaJson(tool: { inputSchema?: unknown } | undefined) {
  return JSON.stringify((tool?.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema ?? {});
}

test("model-facing image-asset schemas accept assetId and expose no binary fields", () => {
  const tools = createImageAssetTools({
    assets: {
      listImages: async () => ({ items: [], offset: 0, limit: 20 }),
      readBytes: async () => ({ bytes: pngA, contentType: "image/png" }),
    },
    ownerUserId: "user",
    workspaceId: "workspace",
    mutate: async () => ({ ok: true }),
    canInsert: true,
    canReplace: true,
  });
  for (const name of [
    "document.insert_image_asset",
    "document.replace_image_asset",
    "document.list_image_assets",
  ] as const) {
    const json = schemaJson(tools[name]);
    assert.match(json, /assetId|offset/);
    for (const forbidden of ["bytes", "base64", "dataUrl", "path", "imageBytes", "replacementBytes"]) {
      assert.equal(json.includes(forbidden), false, `${name} must not expose ${forbidden}`);
    }
  }
  assert.match(schemaJson(tools["document.insert_image_asset"]), /"assetId"/);
  assert.match(schemaJson(tools["document.replace_image_asset"]), /"assetId"/);
});

test("unauthorized or unsupported assets fail before mutation", async () => {
  let mutations = 0;
  const mutate = async () => {
    mutations++;
    return { ok: true };
  };
  const foreign = createImageAssetTools({
    assets: {
      listImages: async () => ({ items: [], offset: 0, limit: 20 }),
      readBytes: async () => {
        throw new WorkspaceAssetError(404, "ASSET_NOT_FOUND", "Workspace image not found");
      },
    },
    ownerUserId: "user",
    workspaceId: "workspace",
    mutate,
    canInsert: true,
    canReplace: true,
  });
  await assert.rejects(
    () =>
      foreign["document.insert_image_asset"]!.execute!(
        { assetId: randomUUID(), placement: { kind: "end" } },
        call,
      ),
    /not found/i,
  );
  assert.equal(mutations, 0);

  const unsupported = createImageAssetTools({
    assets: {
      listImages: async () => ({ items: [], offset: 0, limit: 20 }),
      readBytes: async () => ({ bytes: Buffer.from("%PDF"), contentType: "application/pdf" }),
    },
    ownerUserId: "user",
    workspaceId: "workspace",
    mutate,
    canInsert: true,
  });
  await assert.rejects(
    () =>
      unsupported["document.insert_image_asset"]!.execute!(
        { assetId: randomUUID(), placement: { kind: "end" } },
        call,
      ),
    /PNG and JPEG/,
  );
  assert.equal(mutations, 0);

  await assert.rejects(
    () =>
      resolveOwnedEngineImage(
        {
          listImages: async () => ({ items: [], offset: 0, limit: 20 }),
          readBytes: async () => ({ bytes: Buffer.from("RIFF"), contentType: "image/webp" }),
        },
        "workspace",
        "user",
        randomUUID(),
      ),
    /PNG and JPEG/,
  );
});

test("replace_image_asset preserves layout and rich_content loads asset tools lazily", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const caps = new Set(binding.getDocxCapabilities().formats[0]?.capabilities ?? []);
  if (!caps.has("replace_picture") || !caps.has("layout_snapshot") || !caps.has("insert_picture")) {
    return t.skip("local image engine required");
  }
  const assetId = randomUUID();
  const layout: DocxFloatingImageLayout = {
    horizontal: { reference: "margin", alignment: "end" },
    vertical: { reference: "paragraph", offsetEmu: 0 },
    wrap: "square",
  };
  const seeded = await binding.executeDocxInsertPicture!(binding.createBlankDocx(), {
    imageBytes: pngA,
    placement: { kind: "end" },
    widthEmu: 914400,
    layout,
  });
  assert.equal(seeded.result.ok, true);
  let stored = Buffer.from(seeded.output!);
  let appends = 0;
  let reads = 0;
  const session = await createPrimaryDocxTools({
    binding,
    ownerUserId: "user",
    workspaceId: "workspace",
    documentId: "doc",
    versionId: "v1",
    workspaceAssets: {
      listImages: async () => ({
        items: [{
          assetId,
          contentType: "image/png",
          width: 10,
          height: 10,
          sizeBytes: pngB.length,
          createdAt: new Date().toISOString(),
        }],
        offset: 0,
        limit: 20,
      }),
      readBytes: async (_workspaceId, _userId, id) => {
        assert.equal(id, assetId);
        reads++;
        return { bytes: pngB, contentType: "image/png" };
      },
    },
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => {
        stored = Buffer.from(bytes);
        appends++;
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
    } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  assert.equal(surface.initialTools["document.replace_image_asset"], undefined);
  assert.equal(surface.session.load(["document.rich_content"]).ok, true);
  const tools = surface.projectTools();
  assert.ok(tools["document.list_image_assets"]);
  assert.ok(tools["document.insert_image_asset"]);
  assert.ok(tools["document.replace_image_asset"]);

  const listed = await tools["document.list_image_assets"]!.execute!({}, call) as {
    items: { assetId: string; contentType: string }[];
  };
  assert.deepEqual(listed.items.map((item) => item.assetId), [assetId]);
  assert.equal(JSON.stringify(listed).includes("bytes"), false);

  assert.equal(surface.session.load(["document.layout"]).ok, true);
  const layoutTools = surface.projectTools();
  const layoutInspection = await layoutTools["document.inspect_layout"]!.execute!({}, call) as {
    layout: DocxLayoutSnapshot;
  };
  const before = layoutInspection.layout.images[0]!;
  assert.equal(before.kind, "anchored");
  assert.equal(before.anchor?.wrap, "square");
  const replaced = await layoutTools["document.replace_image_asset"]!.execute!(
    { handle: before.handle!, assetId },
    call,
  ) as { ok: boolean };
  assert.equal(replaced.ok, true);
  assert.equal(reads, 1);
  assert.equal(appends, 0);
  await session.flush();
  assert.equal(appends, 1);
  const after = (await binding.inspectDocxLayout!(stored)).images[0]!;
  assert.deepEqual(after.anchor, before.anchor);
  assert.equal(after.displayWidthEmu, before.displayWidthEmu);
  assert.equal(after.displayHeightEmu, before.displayHeightEmu);
  assert.notEqual(after.assetPartName, undefined);

  // Stale handle must not mutate.
  const stale = await layoutTools["document.replace_image_asset"]!.execute!(
    { handle: before.handle!, assetId },
    call,
  ) as { ok: boolean; reasonCode?: string };
  assert.equal(stale.ok, false);
  assert.equal(stale.reasonCode, "STALE_HANDLE");

  // Insert after a paragraph via asset ID.
  const blank = await createPrimaryDocxTools({
    binding,
    ownerUserId: "user",
    workspaceId: "workspace",
    documentId: "doc2",
    versionId: "v1",
    workspaceAssets: {
      listImages: async () => ({ items: [], offset: 0, limit: 20 }),
      readBytes: async () => ({ bytes: pngA, contentType: "image/png" }),
    },
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => new Uint8Array(buildMinimalDocx(["Results"])),
      appendDocumentVersion: async () => ({ version: { id: "v2", versionNumber: 2 } }) as never,
    } as never,
  });
  assert.ok(blank);
  const blankSurface = createToolSurface(blank.tools);
  assert.equal(blankSurface.session.load(["document.rich_content"]).ok, true);
  const blankTools = blankSurface.projectTools();
  const blocks = await blankTools["document.inspect"]!.execute!(
    { kind: "body_blocks" },
    call,
  ) as { bodyBlocks?: { items?: { handle?: string; kind?: string }[] } };
  const paragraph = blocks.bodyBlocks?.items?.find((item) => item.kind === "paragraph");
  assert.ok(paragraph?.handle);
  const inserted = await blankTools["document.insert_image_asset"]!.execute!({
    assetId,
    placement: { kind: "after", handle: paragraph.handle },
    widthEmu: 914400,
    layout,
  }, call) as { ok: boolean };
  assert.equal(inserted.ok, true);
});
