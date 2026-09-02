import assert from "node:assert/strict";
import { test } from "node:test";

import { EngineClient } from "../engine-client.js";
import { MockEngineTransport } from "../mock-transport.js";
import {
  sampleInspectDocumentFailure,
  sampleInspectDocumentRequest,
  sampleInspectDocumentSuccess,
} from "../__fixtures__/inspect-document.js";

test("inspectDocument returns a successful result from the transport unmodified", async () => {
  const transport = new MockEngineTransport(() => sampleInspectDocumentSuccess);
  const client = new EngineClient(transport);

  const result = await client.inspectDocument(sampleInspectDocumentRequest);

  assert.deepStrictEqual(result, sampleInspectDocumentSuccess);
});

test("inspectDocument propagates a structured engine failure unmodified", async () => {
  const transport = new MockEngineTransport(() => sampleInspectDocumentFailure);
  const client = new EngineClient(transport);

  const result = await client.inspectDocument(sampleInspectDocumentRequest);

  assert.deepStrictEqual(result, sampleInspectDocumentFailure);
  assert.strictEqual(result.status, "error");
  if (result.status === "error") {
    assert.strictEqual(result.diagnostics[0].code, "engine.docx.malformed_xml");
    assert.strictEqual(result.diagnostics[0].severity, "error");
  }
});

test("EngineClient forwards the exact request to the transport, unchanged", async () => {
  const transport = new MockEngineTransport(() => sampleInspectDocumentSuccess);
  const client = new EngineClient(transport);

  await client.inspectDocument(sampleInspectDocumentRequest);

  assert.strictEqual(transport.receivedRequests.length, 1);
  assert.deepStrictEqual(transport.receivedRequests[0], sampleInspectDocumentRequest);
});

test("EngineClient does not swallow a rejected transport promise", async () => {
  const transport = new MockEngineTransport(() => {
    throw new Error("transport unavailable");
  });
  const client = new EngineClient(transport);

  await assert.rejects(
    () => client.inspectDocument(sampleInspectDocumentRequest),
    /transport unavailable/,
  );
});
