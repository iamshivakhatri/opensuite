import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
} from "@opensuite/engine-client";

import { createPrimaryDocxTools } from "./docx-tools.js";
import { normalizeDocumentRenameName } from "../documents/format.js";
import { DocumentAccessError } from "../documents/service.js";

function memoryDocs(seed: {
  documentId: string;
  versionId: string;
  name: string;
  bytes: Buffer;
}) {
  const docs = new Map<
    string,
    {
      name: string;
      format: "docx";
      workspaceId: string;
      versions: Map<string, { number: number; bytes: Buffer }>;
      latestVersionId: string;
    }
  >();

  docs.set(seed.documentId, {
    name: seed.name,
    format: "docx",
    workspaceId: "ws-1",
    versions: new Map([[seed.versionId, { number: 1, bytes: seed.bytes }]]),
    latestVersionId: seed.versionId,
  });

  let nextDoc = 2;
  let nextVer = 100;

  return {
    store: docs,
    api: {
      getOwnedDocument: async (input: { documentId: string }) => {
        const doc = docs.get(input.documentId);
        if (!doc) throw new Error("not found");
        const latest = doc.versions.get(doc.latestVersionId)!;
        return {
          id: input.documentId,
          name: doc.name,
          format: "docx",
          workspaceId: doc.workspaceId,
          latestVersion: {
            id: doc.latestVersionId,
            versionNumber: latest.number,
          },
        } as never;
      },
      readExactVersionBytes: async (input: {
        documentId: string;
        versionId: string;
      }) => {
        const bytes = docs.get(input.documentId)?.versions.get(input.versionId)
          ?.bytes;
        if (!bytes) throw new Error("missing bytes");
        return Buffer.from(bytes);
      },
      appendDocumentVersion: async (input: {
        documentId: string;
        baseVersionId: string;
        bytes: Buffer;
      }) => {
        const doc = docs.get(input.documentId);
        if (!doc) throw new Error("missing doc");
        assert.equal(input.baseVersionId, doc.latestVersionId);
        const number =
          (doc.versions.get(doc.latestVersionId)?.number ?? 0) + 1;
        const versionId = `ver-${nextVer++}`;
        doc.versions.set(versionId, {
          number,
          bytes: Buffer.from(input.bytes),
        });
        doc.latestVersionId = versionId;
        return {
          version: { id: versionId, versionNumber: number },
        } as never;
      },
      createBlankDocxDocument: async (input: {
        name?: string;
        source?: string;
      }) => {
        const binding = await createNapiDocxEngineBinding();
        const bytes = Buffer.from(binding.createBlankDocx());
        const documentId = `doc-${nextDoc++}`;
        const versionId = `ver-${nextVer++}`;
        const name = input.name
          ? input.name.toLowerCase().endsWith(".docx")
            ? input.name
            : `${input.name}.docx`
          : "Untitled Document.docx";
        docs.set(documentId, {
          name,
          format: "docx",
          workspaceId: "ws-1",
          versions: new Map([[versionId, { number: 1, bytes }]]),
          latestVersionId: versionId,
        });
        assert.equal(input.source, "agent");
        return {
          document: { id: documentId, name, format: "docx" },
          version: { id: versionId, versionNumber: 1 },
        } as never;
      },
      createOfficeDocumentFromBytes: async (input: {
        filename: string;
        bytes: Buffer;
        source: string;
      }) => {
        assert.equal(input.source, "agent");
        const documentId = `doc-${nextDoc++}`;
        const versionId = `ver-${nextVer++}`;
        docs.set(documentId, {
          name: input.filename,
          format: "docx",
          workspaceId: "ws-1",
          versions: new Map([
            [versionId, { number: 1, bytes: Buffer.from(input.bytes) }],
          ]),
          latestVersionId: versionId,
        });
        return {
          document: {
            id: documentId,
            name: input.filename,
            format: "docx",
          },
          version: { id: versionId, versionNumber: 1 },
        } as never;
      },
      rename: async (input: { documentId: string; name: string }) => {
        const doc = docs.get(input.documentId);
        if (!doc) throw new Error("missing doc");
        const name = normalizeDocumentRenameName(input.name, doc.format);
        if (!name) throw new DocumentAccessError(400, "INVALID_DOCUMENT_NAME", "Invalid document name");
        doc.name = name;
        return { id: input.documentId, name } as never;
      },
    },
  };
}

test("ten new documents keep distinct filenames and an earlier one can be renamed", async () => {
  const binding = await createNapiDocxEngineBinding();
  const mem = memoryDocs({ documentId: "doc-1", versionId: "ver-1", name: "Source.docx", bytes: Buffer.from(buildMinimalDocx(["Source"])) });
  const renamedEvents: Array<{ documentId: string; name: string }> = [];
  const tools = await createPrimaryDocxTools({ binding, documents: mem.api, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "ver-1", onDocumentRenamed: (event) => { renamedEvents.push(event); } });
  assert.ok(tools);
  const call = { toolCallId: "name", messages: [], context: undefined as never };
  const ids: string[] = [];
  for (let number = 1; number <= 10; number++) {
    const result = await tools.tools["workspace.create_blank_document"]!.execute!({ title: `Report ${number}` }, call) as { documentId: string; title: string };
    ids.push(result.documentId);
    assert.equal(result.title, `Report ${number}.docx`);
  }
  assert.equal(new Set(ids).size, 10);
  const result = await tools.tools["workspace.rename_document"]!.execute!({ documentId: ids[0], name: "Final Report" }, call);
  assert.deepEqual(result, { ok: true, documentId: ids[0], name: "Final Report.docx" });
  assert.deepEqual(renamedEvents, [{ documentId: ids[0], name: "Final Report.docx" }]);
  assert.equal(mem.store.get(ids[0]!)!.versions.size, 1);
  assert.equal(tools.getActiveDocumentId(), ids[9]);
  assert.equal(mem.store.get(ids[9]!)!.name, "Report 10.docx");
  assert.deepEqual(await tools.tools["workspace.rename_document"]!.execute!({ documentId: ids[0], name: "Wrong.xlsx" }, call), { ok: false, reasonCode: "INVALID_DOCUMENT_NAME" });
  assert.equal(mem.store.get(ids[0]!)!.name, "Final Report.docx");
  mem.store.get(ids[0]!)!.workspaceId = "other-workspace";
  assert.deepEqual(await tools.tools["workspace.rename_document"]!.execute!({ documentId: ids[0], name: "Wrong" }, call), { ok: false, reasonCode: "DOCUMENT_NOT_IN_WORKSPACE" });
});

test("duplicate switches active binding; subsequent mutate targets only the copy", async () => {
  const binding = await createNapiDocxEngineBinding();
  const initial = Buffer.from(buildMinimalDocx(["Key HighStone"]));
  const mem = memoryDocs({
    documentId: "doc-1",
    versionId: "ver-1",
    name: "Source.docx",
    bytes: initial,
  });
  const createdEvents: Array<{ documentId: string; kind: string }> = [];

  const tools = await createPrimaryDocxTools({
    binding,
    documents: mem.api,
    ownerUserId: "user-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    onDocumentCreated: async (event) => {
      createdEvents.push({
        documentId: event.documentId,
        kind: event.kind,
      });
    },
  });
  assert.ok(tools);
  assert.ok(tools.tools["workspace.duplicate_current_document"]);
  assert.ok(tools.tools["workspace.create_blank_document"]);

  const duplicate = tools.tools["workspace.duplicate_current_document"];
  assert.ok(duplicate?.execute);
  const dup = await duplicate.execute(
    { title: "Copy.docx" },
    { toolCallId: "d1", messages: [], context: undefined as never },
  );
  assert.equal((dup as { created: boolean }).created, true);
  assert.equal(createdEvents.length, 1);
  assert.equal(createdEvents[0]!.kind, "duplicated");

  const copyId = tools.getActiveDocumentId();
  assert.ok(copyId);
  assert.notEqual(copyId, "doc-1");
  assert.equal(tools.getTransitions()[0]!.kind, "duplicated");

  const sourceBytes = await mem.api.readExactVersionBytes({
    documentId: "doc-1",
    versionId: "ver-1",
  });
  const copyVersionId = tools.getActiveVersionId()!;
  const copyBytes = await mem.api.readExactVersionBytes({
    documentId: copyId!,
    versionId: copyVersionId,
  });
  assert.deepEqual(copyBytes, sourceBytes);

  const replace = tools.tools["document.replace_text"];
  assert.ok(replace?.execute);
  await replace.execute(
    {
      target: { text: "Key HighStone" },
      expectedCurrentText: "Key HighStone",
      replacement: "Key Milestones",
    },
    { toolCallId: "m1", messages: [], context: undefined as never },
  );

  // Original unchanged
  const sourceAfter = await mem.api.readExactVersionBytes({
    documentId: "doc-1",
    versionId: "ver-1",
  });
  assert.deepEqual(sourceAfter, initial);
  assert.equal(mem.store.get("doc-1")!.latestVersionId, "ver-1");

  // Copy advanced
  assert.equal(tools.getActiveVersionId(), copyVersionId);
  await tools.flush();
  assert.notEqual(tools.getActiveVersionId(), copyVersionId);
  assert.equal(tools.getActiveDocumentId(), copyId);
});

test("select existing working document rebinds before editing", async () => {
  const binding = await createNapiDocxEngineBinding();
  const mem = memoryDocs({ documentId: "doc-1", versionId: "ver-1", name: "Old.docx", bytes: Buffer.from(buildMinimalDocx(["Old period"])) });
  const setup = await createPrimaryDocxTools({ binding, documents: mem.api, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "ver-1" });
  assert.ok(setup);
  const call = { toolCallId: "select", messages: [], context: undefined as never };
  await setup.tools["workspace.duplicate_current_document"]!.execute!({ title: "Updates.docx" }, call);
  const sourceId = setup.getActiveDocumentId()!;
  const tools = await createPrimaryDocxTools({ binding, documents: mem.api, ownerUserId: "user-1", workspaceId: "ws-1", documentId: sourceId, versionId: setup.getActiveVersionId(), workingDocumentIds: ["doc-1", sourceId] });
  assert.ok(tools);
  assert.equal((await tools.tools["workspace.select_document"]!.execute!({ documentId: "doc-1" }, call) as { ok: boolean }).ok, true);
  assert.equal(tools.getActiveDocumentId(), "doc-1");
  assert.match(JSON.stringify(await tools.tools["document.inspect"]!.execute!({ kind: "body_blocks" }, call)), /Old period/);
  assert.equal((await tools.tools["document.replace_text"]!.execute!({ target: { text: "Old period" }, expectedCurrentText: "Old period", replacement: "New period" }, call) as { ok: boolean }).ok, true);
  assert.equal((await tools.tools["workspace.select_document"]!.execute!({ documentId: sourceId }, call) as { reasonCode: string }).reasonCode, "DOCUMENT_ALREADY_EDITED");
  await tools.flush();
  assert.equal(mem.store.get("doc-1")!.versions.size, 2);
  assert.equal(mem.store.get(sourceId)!.versions.size, 1);
});

test("inspect and explicitly select an untagged workspace DOCX before one locked edit", async () => {
  const binding = await createNapiDocxEngineBinding();
  const mem = memoryDocs({ documentId: "active", versionId: "v1", name: "Active.docx", bytes: Buffer.from(buildMinimalDocx(["Active text"])) });
  mem.store.set("found", { name: "Found.docx", format: "docx", workspaceId: "ws-1",
    versions: new Map([["v2", { number: 1, bytes: Buffer.from(buildMinimalDocx(["Found evidence"])) }]]), latestVersionId: "v2" });
  mem.store.set("outside", { name: "Outside.docx", format: "docx", workspaceId: "ws-2",
    versions: new Map([["v3", { number: 1, bytes: Buffer.from(buildMinimalDocx(["Outside evidence"])) }]]), latestVersionId: "v3" });
  const tools = await createPrimaryDocxTools({ binding, documents: mem.api, ownerUserId: "user-1", workspaceId: "ws-1",
    documentId: "active", versionId: "v1", workingDocumentIds: ["active"] });
  assert.ok(tools);
  const call = { toolCallId: "inspect", messages: [], context: undefined as never };
  const result = await tools.tools["workspace.inspect_document"]!.execute!({ documentId: "found", kind: "body_blocks" }, call);
  assert.match(JSON.stringify(result), /Found evidence/);
  assert.equal(tools.getActiveDocumentId(), "active");
  assert.equal((await tools.tools["workspace.inspect_document"]!.execute!({ documentId: "outside", kind: "body_blocks" }, call) as { reasonCode: string }).reasonCode, "DOCUMENT_NOT_READABLE");
  assert.equal((await tools.tools["workspace.select_document"]!.execute!({ documentId: "outside" }, call) as { reasonCode: string }).reasonCode, "DOCUMENT_NOT_EDITABLE");
  assert.equal(tools.getActiveDocumentId(), "active");
  assert.equal((await tools.tools["workspace.select_document"]!.execute!({ documentId: "found" }, call) as { ok: boolean }).ok, true);
  assert.equal(tools.getActiveDocumentId(), "found");
  assert.equal(mem.store.get("found")!.versions.size, 1);
  assert.equal((await tools.tools["document.replace_text"]!.execute!({ target: { text: "Found evidence" }, expectedCurrentText: "Found evidence", replacement: "Updated evidence" }, call) as { ok: boolean }).ok, true);
  assert.equal((await tools.tools["workspace.select_document"]!.execute!({ documentId: "active" }, call) as { reasonCode: string }).reasonCode, "DOCUMENT_ALREADY_EDITED");
  await tools.flush();
  assert.equal(mem.store.get("found")!.versions.size, 2);
  assert.equal(mem.store.get("active")!.versions.size, 1);
});

test("create blank becomes active; subsequent mutation targets the blank", async () => {
  const binding = await createNapiDocxEngineBinding();
  const initial = Buffer.from(buildMinimalDocx(["Keep me"]));
  const mem = memoryDocs({
    documentId: "doc-1",
    versionId: "ver-1",
    name: "Source.docx",
    bytes: initial,
  });
  const created: string[] = [];

  const tools = await createPrimaryDocxTools({
    binding,
    documents: mem.api,
    ownerUserId: "user-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    onDocumentCreated: async (event) => {
      created.push(event.documentId);
    },
  });
  assert.ok(tools);

  const createBlank = tools.tools["workspace.create_blank_document"];
  assert.ok(createBlank?.execute);
  await createBlank.execute(
    { title: "Weekly Plan" },
    { toolCallId: "c1", messages: [], context: undefined as never },
  );
  assert.equal(created.length, 1);
  const blankId = tools.getActiveDocumentId();
  assert.equal(blankId, created[0]);
  assert.notEqual(blankId, "doc-1");

  const insert = tools.tools["document.insert_paragraph"];
  assert.ok(insert?.execute);
  await insert.execute(
    { text: "Weekly Plan", placement: { kind: "end" } },
    { toolCallId: "m1", messages: [], context: undefined as never },
  );
  await insert.execute(
    { text: "Next step", placement: { kind: "end" } },
    { toolCallId: "m2", messages: [], context: undefined as never },
  );

  assert.equal(mem.store.get("doc-1")!.latestVersionId, "ver-1");
  assert.equal(tools.getActiveDocumentId(), blankId);
  assert.equal(mem.store.get(blankId!)!.versions.size, 1);
  await tools.flush();
  assert.ok(
    mem.store.get(blankId!)!.versions.size === 2,
    "blank received one final mutation version",
  );
});

test("failed duplicate leaves original binding active", async () => {
  const binding = await createNapiDocxEngineBinding();
  const initial = Buffer.from(buildMinimalDocx(["Hello"]));
  const mem = memoryDocs({
    documentId: "doc-1",
    versionId: "ver-1",
    name: "Source.docx",
    bytes: initial,
  });
  mem.api.createOfficeDocumentFromBytes = async () => {
    throw Object.assign(new Error("quota"), {
      name: "DocumentUploadError",
      code: "STORAGE_QUOTA_EXCEEDED",
      statusCode: 409,
    });
  };

  // Use real DocumentUploadError
  const { DocumentUploadError } = await import("../documents/service.js");
  mem.api.createOfficeDocumentFromBytes = async () => {
    throw new DocumentUploadError(409, "STORAGE_QUOTA_EXCEEDED", "quota");
  };

  const tools = await createPrimaryDocxTools({
    binding,
    documents: mem.api,
    ownerUserId: "user-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
  });
  assert.ok(tools);

  const duplicate = tools.tools["workspace.duplicate_current_document"];
  assert.ok(duplicate?.execute);
  const result = await duplicate.execute(
    {},
    { toolCallId: "d1", messages: [], context: undefined as never },
  );
  assert.equal((result as { ok: boolean }).ok, false);
  assert.equal(tools.getActiveDocumentId(), "doc-1");
  assert.equal(tools.getActiveVersionId(), "ver-1");
  assert.equal(tools.getTransitions().length, 0);
});

test("finish-as-read before mutations: duplicate then mutate still targets copy", async () => {
  // Mirrors V3 scheduling: reads (finish) run before mutations in a multi-tool turn.
  const { createFinishTool } = await import("@opensuite/agent-core-v3");
  const binding = await createNapiDocxEngineBinding();
  const initial = Buffer.from(buildMinimalDocx(["Key HighStone"]));
  const mem = memoryDocs({
    documentId: "doc-1",
    versionId: "ver-1",
    name: "Source.docx",
    bytes: initial,
  });

  const tools = await createPrimaryDocxTools({
    binding,
    documents: mem.api,
    ownerUserId: "user-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
  });
  assert.ok(tools);
  const finish = createFinishTool();
  assert.ok(finish.tool.execute);

  // Read phase first (finish)
  const summary = await finish.tool.execute(
    {},
    { toolCallId: "f1", messages: [], context: undefined as never },
  );
  assert.equal(summary, "");
  assert.equal(tools.getActiveDocumentId(), "doc-1");

  // Mutation phase: duplicate then replace
  const duplicate = tools.tools["workspace.duplicate_current_document"];
  assert.ok(duplicate?.execute);
  await duplicate.execute(
    {},
    { toolCallId: "d1", messages: [], context: undefined as never },
  );
  const copyId = tools.getActiveDocumentId();
  assert.notEqual(copyId, "doc-1");

  const replace = tools.tools["document.replace_text"];
  assert.ok(replace?.execute);
  await replace.execute(
    {
      target: { text: "Key HighStone" },
      expectedCurrentText: "Key HighStone",
      replacement: "Key Milestones",
    },
    { toolCallId: "m1", messages: [], context: undefined as never },
  );

  assert.equal(mem.store.get("doc-1")!.latestVersionId, "ver-1");
  await tools.flush();
  assert.ok(mem.store.get(copyId!)!.versions.size >= 2);
});

test("duplicate without active document returns structured failure", async () => {
  const binding = await createNapiDocxEngineBinding();
  const mem = memoryDocs({
    documentId: "doc-1",
    versionId: "ver-1",
    name: "Source.docx",
    bytes: Buffer.from(buildMinimalDocx(["x"])),
  });

  const tools = await createPrimaryDocxTools({
    binding,
    documents: mem.api,
    ownerUserId: "user-1",
    workspaceId: "ws-1",
    documentId: null,
    versionId: null,
  });
  assert.ok(tools);
  assert.equal(tools.getActiveDocumentId(), null);

  const duplicate = tools.tools["workspace.duplicate_current_document"];
  assert.ok(duplicate?.execute);
  const result = await duplicate.execute(
    {},
    { toolCallId: "d1", messages: [], context: undefined as never },
  );
  assert.equal((result as { reasonCode: string }).reasonCode, "NO_ACTIVE_DOCUMENT");
});
