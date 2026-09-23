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
