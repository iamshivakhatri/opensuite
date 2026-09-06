import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";

import type { DocumentRef } from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import { createNapiDocxEngineBinding } from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";

const SMOKE_OUTPUT = "/private/tmp/opensuite-app-engine-adapter-output.docx";

test("smoke: OpenSuiteEngineAdapter → N-API → verified DOCX bytes", async (t) => {
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
  assert.ok(success.artifactBytes!.byteLength > 0);
  assert.notDeepEqual(
    Buffer.from(success.artifactBytes!),
    Buffer.from(inputBytes),
  );
  assertNoEngineSourceIdentities(success);

  // Manual QA convenience only — execution itself is bytes→binding→bytes.
  writeFileSync(SMOKE_OUTPUT, success.artifactBytes!);

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

  const precondition = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "smoke-ver-1",
    payload: {
      find: "old text",
      replace: "x",
      expectedCurrentText: "stale expected",
    },
  });
  assert.equal(precondition.status, "error");
  if (precondition.status === "error") {
    assert.equal(precondition.code, "PRECONDITION_FAILED");
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
