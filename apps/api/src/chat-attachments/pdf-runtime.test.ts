import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buildTestPdf } from "./pdf-test-fixture.js";
import { createAttachmentExtractionService, type AttachmentSource } from "./extraction.js";
import type { ChatAttachmentDto } from "./service.js";

const scope = { workspaceId: "workspace", threadId: "thread", userId: "user" };
function sourceFixture() {
  const bytes = buildTestPdf([["Revenue $42,750; margin 18.5%."], null]);
  const meta = { id: "pdf", ...scope, filename: "report.pdf", mediaType: "application/pdf", sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), messageId: "message", kind: "file", status: "bound",
    createdAt: new Date().toISOString(), boundAt: new Date().toISOString() } satisfies ChatAttachmentDto;
  const cache = new Map<string, Buffer>();
  const source: AttachmentSource = {
    getBound: async () => meta, list: async () => [meta],
    read: async () => ({ ...meta, body: Readable.from([bytes]), contentLength: bytes.length }),
    readExtraction: async () => cache.get(meta.id) ?? null,
    saveExtraction: async ({ bytes }) => { cache.set(meta.id, bytes); },
  };
  return { source, meta, cache };
}

test("source-mode API with the real tsx loader extracts, searches, reads, renders and reuses PDF caches after restart", async () => {
  // Previous compiled-only tests never inherited the development loader into the bounded workers.
  const extraction = new URL("../../src/chat-attachments/extraction.ts", import.meta.url).href;
  const evidence = new URL("../../src/agent/attachment-evidence.ts", import.meta.url).href;
  const fixture = new URL("./pdf-test-fixture.js", import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { createHash } from 'node:crypto';
    import { Readable } from 'node:stream';
    import { createAttachmentExtractionService } from ${JSON.stringify(extraction)};
    import { createAttachmentEvidence, createAttachmentTools } from ${JSON.stringify(evidence)};
    import { buildTestPdf } from ${JSON.stringify(fixture)};
    const scope = ${JSON.stringify(scope)};
    const detail = Array.from({length:13}, (_, i) => 'Weekly delivery update item '+i+': reviewed shipment metrics and assigned follow-up owner.');
    for (const pages of [[['Revenue $42,750; margin 18.5%.', ...detail], ['Owner Mira; launch June 12.', ...detail]], [['Revenue $42,750; margin 18.5%.'], null]]) {
      const bytes = buildTestPdf(pages, {title:'Business report', structure:true});
      const meta = {id:'pdf', ...scope, filename:'report.pdf', mediaType:'application/pdf', sizeBytes:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex')};
      let cache, reads = 0;
      const source = {getBound:async()=>meta, list:async()=>[meta], read:async()=>{reads++;return {...meta, body:Readable.from([bytes])}}, readExtraction:async()=>cache??null, saveExtraction:async({bytes})=>{cache=bytes}};
      const service = createAttachmentExtractionService(source);
      const manifestText = await createAttachmentEvidence(service, scope, ['pdf'], 'Summarize report')(12000);
      const manifest = JSON.parse(manifestText.split('\\n').slice(1).join('\\n')).attachments[0];
      assert.equal(manifest.contentComplete, true);
      assert.equal(manifest.pageCount, 2);
      const {extraction} = await service.get(scope, 'pdf');
      assert.equal(extraction.units[0].page.textStatus, 'digital_text');
      assert.equal(extraction.units[1].page.textStatus, pages[1] ? 'digital_text' : 'no_text');
      const tools = createAttachmentTools(service, scope);
      const search = await tools['attachment.search'].execute({attachmentIds:['pdf'], query:'42,750'}, {});
      assert.equal(search.ok, true); assert.equal(search.matches[0].location, 'page:1');
      const read = await tools['attachment.read'].execute({attachmentId:'pdf', extractionId:extraction.extractionId, location:'page:1'}, {});
      assert.equal(read.ok, true); assert.match(read.content[0].text, /42,750/);
      const {visual} = await service.view(scope, 'pdf', extraction.extractionId, 2);
      const jpeg = Buffer.from(visual.representation.base64, 'base64');
      assert.equal(jpeg.readUInt16BE(0), 0xffd8); assert.ok(jpeg.length > 1000);
      assert.ok(visual.representation.width <= 1600 && visual.representation.height <= 1600);
      const restarted = createAttachmentExtractionService(source);
      assert.deepEqual((await restarted.view(scope, 'pdf', extraction.extractionId, 2)).visual, visual);
      assert.equal(reads, 2);
    }
    console.log('PDF source-mode smoke passed');
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { timeout: 30_000, env: { ...process.env, NODE_OPTIONS: `--import ${import.meta.resolve("tsx")}` } });
  assert.match(stdout, /PDF source-mode smoke passed/);
});

test("unexpected PDF worker exit retries once, shares work, and does not poison a later service", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "opensuite-pdf-worker-"));
  const crashedWorker = join(directory, "crash.mjs");
  await writeFile(crashedWorker, "process.once('message', () => process.exit(1));");
  const fork = childProcess.fork;
  let calls = 0;
  let alwaysFail = false;
  t.mock.method(childProcess, "fork", ((path: Parameters<typeof fork>[0], args: string[], options: Parameters<typeof fork>[2]) => {
    calls++;
    return fork(calls === 1 || alwaysFail ? crashedWorker : path, args, options);
  }) as typeof fork);
  syncBuiltinESMExports();
  try {
    const { source, meta, cache } = sourceFixture();
    const service = createAttachmentExtractionService(source);
    const [first, second] = await Promise.all([service.get(scope, meta.id), service.get(scope, meta.id)]);
    assert.equal(first.extraction, second.extraction);
    assert.equal(first.extraction.pdf?.pageCount, 2);
    assert.equal(calls, 2, "one failed child plus exactly one retry");
    cache.clear(); alwaysFail = true; calls = 0;
    const failing = createAttachmentExtractionService(source);
    await assert.rejects(failing.get(scope, meta.id), { code: "PDF_WORKER_FAILED", retryable: true, stage: "worker_exit" });
    await assert.rejects(failing.get(scope, meta.id), { code: "PDF_WORKER_FAILED" });
    assert.equal(calls, 2, "repeated tool access cannot immediately start more failed children");
    assert.equal(cache.size, 0, "failure is never persisted as an extraction");
    alwaysFail = false;
    assert.equal((await createAttachmentExtractionService(source).get(scope, meta.id)).extraction.pdf?.pageCount, 2);
  } finally {
    t.mock.restoreAll(); syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

test("temporary cache errors expire in the same service and safe diagnostics exclude storage details", async (t) => {
  const { source, meta, cache } = sourceFixture();
  let unavailable = true;
  const readCache = source.readExtraction;
  source.readExtraction = async input => {
    if (unavailable) throw new Error("private bucket/key and secret credentials");
    return readCache(input);
  };
  const logs: string[] = [];
  t.mock.method(console, "warn", (...values: unknown[]) => { logs.push(values.join(" ")); });
  t.mock.timers.enable({ apis: ["Date"] });
  const service = createAttachmentExtractionService(source);
  await assert.rejects(service.get(scope, meta.id), { code: "EXTRACTION_CACHE_UNAVAILABLE", retryable: true, stage: "cache_read" });
  assert.equal(cache.size, 0);
  unavailable = false;
  t.mock.timers.tick(5_001);
  assert.equal((await service.get(scope, meta.id)).extraction.pdf?.pageCount, 2);
  assert.match(logs.join(" "), /"stage":"cache_read".*"retryable":true/);
  assert.doesNotMatch(logs.join(" "), /private bucket|secret credentials/);
});
