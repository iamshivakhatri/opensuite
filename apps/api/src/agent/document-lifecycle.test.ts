import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
} from "@opensuite/engine-client";

import { createPrimaryDocxTools } from "./docx-tools.js";

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
    },
  };
}

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
  assert.notEqual(tools.getActiveVersionId(), copyVersionId);
  assert.equal(tools.getActiveDocumentId(), copyId);
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

  assert.equal(mem.store.get("doc-1")!.latestVersionId, "ver-1");
  assert.equal(tools.getActiveDocumentId(), blankId);
  assert.ok(
    mem.store.get(blankId!)!.versions.size >= 2,
    "blank received a mutation version",
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
    { summary: "will finish after mutations" },
    { toolCallId: "f1", messages: [], context: undefined as never },
  );
  assert.equal(summary, "will finish after mutations");
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
