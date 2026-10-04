import assert from "node:assert/strict";
import { test } from "node:test";
import { bindDocxDocument, createNapiDocxEngineBinding, type DocxInspectResult } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

const call = { toolCallId: "e1", messages: [], context: undefined as never };

test("section groups are dynamic and use the existing handle and one-save lifecycle", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("inspect_sections")) return t.skip("local E1 engine required");
  const seed = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  for (let index=0; index<2; index++) assert.equal((await seed.mutate("insert_section_break", { placement: { kind: "end" }, breakType: "nextPage" })).ok, true);
  let stored = Buffer.from(seed.currentBytes());
  let appends = 0;
  const session = await createPrimaryDocxTools({
    binding, ownerUserId: "user", workspaceId: "workspace", documentId: "document", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes, baseVersionId }) => {
        assert.equal(baseVersionId, "v1"); stored=Buffer.from(bytes); appends++;
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  for (const name of ["inspect_sections", "insert_section_break", "set_section_properties", "set_section_header_footer", "set_odd_even_headers"]) assert.equal(surface.initialTools[`document.${name}`], undefined);
  assert.equal(surface.session.load(["document.sections", "document.headers_footers"]).ok, true);
  const tools=surface.projectTools();
  const inspected=await tools["document.inspect_sections"]!.execute!({},call) as DocxInspectResult;
  const handle=inspected.sections![1]!.handle;
  const result=await tools["document.set_section_properties"]!.execute!({ handle, pageSetup: { orientation: "landscape" } },call) as { ok: boolean };
  assert.equal(result.ok,true);
  const after=await tools["document.inspect_sections"]!.execute!({},call) as DocxInspectResult;
  assert.equal(after.sections![1]!.orientation,"landscape");
  const header=await tools["document.set_section_header_footer"]!.execute!({ handle: after.sections![2]!.handle, kind: "footer", variant: "default", action: "text", text: "App footer" },call) as { ok: boolean };
  assert.equal(header.ok,true);
  const stale=await tools["document.set_section_properties"]!.execute!({ handle, differentFirstPage: true },call) as { ok: boolean; reasonCode: string };
  assert.equal(stale.ok,false);assert.equal(stale.reasonCode,"STALE_HANDLE");
  assert.equal(appends,0);
  await session.flush(); await session.flush();assert.equal(appends,1);
  const reopened=await binding.inspectDocx(stored,{focus:{kind:"sections"}});
  assert.equal(reopened.sections![1]!.orientation,"landscape");
  assert.equal(reopened.sections![2]!.headersFooters[3]!.text,"App footer");
});
