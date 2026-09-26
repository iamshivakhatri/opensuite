import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
  else process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
});

test("agent runs keep the active document separate from submitted tags", async () => {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
  let body = "";
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = String(init?.body);
    return new Response(JSON.stringify({ run: { id: "run-1" } }), { status: 202, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const href = new URL("./api.ts", import.meta.url).href;
  const api = await import(`${href}?t=${Date.now()}`);

  await api.startAgentRun("thread-1", "Compare these", {
    activeDocumentId: "active-a",
    documentIds: ["tagged-b", "tagged-c"],
  });

  assert.deepEqual(JSON.parse(body), {
    instruction: "Compare these",
    activeDocumentId: "active-a",
    documentIds: ["tagged-b", "tagged-c"],
  });
});

test("agent stream reports server heartbeats during a model wait", async () => {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
  const encoder = new TextEncoder();
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n: heartbeat\n\nevent: agent.completed\ndata: {"runId":"run-1","type":"agent.completed","data":{}}\n\n'));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  const href = new URL("./api.ts", import.meta.url).href;
  const api = await import(`${href}?t=${Date.now()}`);
  let heartbeats = 0;
  await new Promise<void>((resolve) => api.subscribeAgentRunEvents("run-1", {
    onHeartbeat: () => { heartbeats++; },
    onEvent: (event) => { if (event.type === "agent.completed") resolve(); },
  }));
  assert.equal(heartbeats, 2);
});

test("working preview rejects responses without readable metadata", async () => {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
  globalThis.fetch = (async () => new Response("bytes", { status: 200 })) as typeof fetch;
  const api = await import(`${new URL("./api.ts", import.meta.url).href}?t=${Date.now()}`);
  await assert.rejects(api.fetchWorkingDocument("run-1"), /missing preview metadata/);
});
