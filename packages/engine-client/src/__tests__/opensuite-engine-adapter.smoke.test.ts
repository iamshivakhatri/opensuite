import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import {
  Capabilities,
  hasCapability,
  listCapabilities,
  type DocumentRef,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";

const SMOKE_OUTPUT = "/private/tmp/opensuite-app-engine-adapter-output.docx";

test("smoke: capabilities → find → inspect → replace → find/inspect output", async (t) => {
  let binding;
  try {
    binding = await createNapiDocxEngineBinding();
  } catch (error) {
    t.skip(
      `Native @opensuite/engine binding unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const inputBytes = buildMinimalDocx(["old text", "Date:", "Date:"]);
  const docRef: DocumentRef = {
    documentId: "smoke-doc",
    versionId: "smoke-ver-1",
    format: "docx",
  };

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "smoke-ver-1": inputBytes,
    }),
    binding,
  });

  const caps = await runtime.capabilities(docRef);
  const ids = listCapabilities(caps);
  assert.ok(ids.includes("find_text"));
  assert.ok(ids.includes("inspect_context"));
  assert.ok(ids.includes("replace_text"));
  assert.ok(hasCapability(caps, Capabilities.DocumentFind));
  assert.ok(hasCapability(caps, Capabilities.DocumentInspect));
  assert.ok(hasCapability(caps, Capabilities.DocumentMutate));

  const found = await runtime.find!(docRef, {
    query: "old text",
    mode: "text",
  });
  assert.equal(found.status, "success");
  if (found.status === "success") {
    assert.ok(found.matches.length >= 1);
    assertNoEngineSourceIdentities(found);
  }

  const inspected = await runtime.inspect(docRef, {
    focus: { kind: "context", text: "old text", before: 1, after: 1 },
  });
  assert.equal(inspected.status, "success");
  if (inspected.status === "success" && inspected.payload.format === "docx") {
    assert.equal(inspected.payload.context?.container?.text, "old text");
    assertNoEngineSourceIdentities(inspected);
  }

  const unsupported = await runtime.inspect(docRef, {
    focus: { kind: "headings" },
  });
  assert.equal(unsupported.status, "error");
  if (unsupported.status === "error") {
    assert.equal(unsupported.diagnostics[0]!.code, "UNSUPPORTED_OPERATION");
  }

  const success = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: {
      find: "old text",
      replace: "OpenSuite app adapter replacement",
    },
  });

  assert.equal(success.status, "success");
  if (success.status !== "success") return;
  assert.ok(success.artifactBytes);
  assertNoEngineSourceIdentities(success);
  writeFileSync(SMOKE_OUTPUT, success.artifactBytes!);

  const outputRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "smoke-ver-out": success.artifactBytes!,
    }),
    binding,
  });
  const outRef: DocumentRef = {
    documentId: "smoke-doc",
    versionId: "smoke-ver-out",
    format: "docx",
  };

  const foundOut = await outputRuntime.find!(outRef, {
    query: "OpenSuite app adapter replacement",
    mode: "text",
  });
  assert.equal(foundOut.status, "success");
  if (foundOut.status === "success") {
    assert.ok(foundOut.matches.length >= 1);
  }

  const inspectOut = await outputRuntime.inspect(outRef, {
    focus: {
      kind: "context",
      text: "OpenSuite app adapter replacement",
    },
  });
  assert.equal(inspectOut.status, "success");
  if (inspectOut.status === "success" && inspectOut.payload.format === "docx") {
    assert.equal(
      inspectOut.payload.context?.container?.text,
      "OpenSuite app adapter replacement",
    );
  }

  // Original version bytes still searchable on the original runtime/loader.
  const stillOriginal = await runtime.find!(docRef, {
    query: "old text",
    mode: "text",
  });
  assert.equal(stillOriginal.status, "success");

  const missing = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: { find: "not present", replace: "x" },
  });
  assert.equal(missing.status, "error");
  if (missing.status === "error") {
    assert.equal(missing.code, "TARGET_NOT_FOUND");
  }

  const ambiguous = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: { find: "Date:", replace: "x" },
  });
  assert.equal(ambiguous.status, "error");
  if (ambiguous.status === "error") {
    assert.equal(ambiguous.code, "TARGET_AMBIGUOUS");
  }

  const invalidRuntime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "smoke-ver-1": Buffer.from("not a DOCX"),
    }),
    binding,
  });
  const invalidResult = await invalidRuntime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: { find: "anything", replace: "x" },
  });
  assert.equal(invalidResult.status, "error");
  if (invalidResult.status === "error") {
    assert.equal(invalidResult.code, "DOCUMENT_INVALID");
  }
});
