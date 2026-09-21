import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.NEXT_PUBLIC_API_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) {
    delete process.env.NEXT_PUBLIC_API_URL;
  } else {
    process.env.NEXT_PUBLIC_API_URL = originalApiUrl;
  }
});

async function loadApi() {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
  const href = new URL("./api.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`);
}

function pageResponse(overrides?: {
  messages?: unknown[];
  hasMore?: boolean;
  oldestCursor?: { createdAt: string; id: string } | null;
}) {
  return new Response(
    JSON.stringify({
      messages: overrides?.messages ?? [],
      page: {
        hasMore: overrides?.hasMore ?? false,
        ...(overrides?.oldestCursor
          ? { oldestCursor: overrides.oldestCursor }
          : {}),
      },
      latestRun: null,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("getAgentMessages (C6 pagination client)", () => {
  it("requests the latest page only when no cursor is supplied", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return pageResponse({
        messages: [
          { id: "m1", role: "user", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
        ],
        hasMore: true,
        oldestCursor: { createdAt: "2026-01-01T00:00:00.000Z", id: "m1" },
      });
    }) as typeof fetch;

    const api = await loadApi();
    const page = await api.getAgentMessages("thread-1");

    assert.equal(calls.length, 1);
    assert.equal(calls[0], "http://api.test/api/agent/threads/thread-1/messages");
    assert.equal(page.messages.length, 1);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.oldestCursor, {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "m1",
    });
  });

  it("sends beforeCreatedAt/beforeId when a cursor is provided (cursor advances)", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return pageResponse({ hasMore: false });
    }) as typeof fetch;

    const api = await loadApi();
    await api.getAgentMessages("thread-1", {
      before: { createdAt: "2026-01-01T00:00:00.000Z", id: "m1" },
    });

    assert.equal(calls.length, 1);
    const url = new URL(calls[0]!);
    assert.equal(url.searchParams.get("beforeCreatedAt"), "2026-01-01T00:00:00.000Z");
    assert.equal(url.searchParams.get("beforeId"), "m1");
  });

  it("defaults hasMore to false and oldestCursor to null when page is absent", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch;

    const api = await loadApi();
    const page = await api.getAgentMessages("thread-1");
    assert.equal(page.hasMore, false);
    assert.equal(page.oldestCursor, null);
  });
});
