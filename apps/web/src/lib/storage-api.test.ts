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
  const href = new URL("./storage-api.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`);
}

describe("storage API client", () => {
  it("loads storage status from GET /api/storage", async () => {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return new Response(
        JSON.stringify({
          usedBytes: 42,
          quotaBytes: 500,
          remainingBytes: 458,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = await loadApi();
    const status = await api.fetchStorageStatus();
    assert.equal(url, "http://api.test/api/storage");
    assert.equal(status.usedBytes, 42);
    assert.equal(status.quotaBytes, 500);
    assert.equal(status.remainingBytes, 458);
  });

  it("purges a trashed document via DELETE /api/trash/documents/:id", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const api = await loadApi();
    await api.purgeTrashedDocument("11111111-1111-4111-8111-111111111111");
    assert.deepEqual(calls, [
      "DELETE http://api.test/api/trash/documents/11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("keeps purge failure as an error without inventing success", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            statusCode: 409,
            code: "DOCUMENT_NOT_TRASHED",
            message: "Document is not in trash",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const api = await loadApi();
    await assert.rejects(
      () => api.purgeTrashedDocument("11111111-1111-4111-8111-111111111111"),
      (error: unknown) => {
        assert.ok(error instanceof api.StorageApiError);
        assert.equal(error.code, "DOCUMENT_NOT_TRASHED");
        return true;
      },
    );
  });
});
