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

async function loadClient() {
  process.env.NEXT_PUBLIC_API_URL = "http://api.test";
  const href = new URL("./api-client.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`);
}

describe("api-client", () => {
  it("sends credentials and returns a normal JSON response body", async () => {
    let credentials: RequestCredentials | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      credentials = init?.credentials;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = await loadClient();
    const response = await client.apiFetch("/api/example");
    assert.equal(credentials, "include");
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("parses OpenSuite JSON API errors", async () => {
    const client = await loadClient();
    const response = new Response(
      JSON.stringify({
        error: {
          statusCode: 409,
          code: "VERSION_CONFLICT",
          message: "Document version conflict",
          activeRunId: "run-1",
        },
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
    const error = await client.parseApiError(response);
    assert.ok(error instanceof client.ApiError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, "VERSION_CONFLICT");
    assert.equal(error.message, "Document version conflict");
    assert.equal(error.details?.activeRunId, "run-1");
  });

  it("maps DATABASE_UNAVAILABLE to the fixed product message", async () => {
    const client = await loadClient();
    const response = new Response(
      JSON.stringify({
        error: {
          statusCode: 503,
          code: "DATABASE_UNAVAILABLE",
          message: "ignored upstream wording",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
    const error = await client.parseApiError(response);
    assert.equal(error.code, "DATABASE_UNAVAILABLE");
    assert.equal(error.message, "No connection with the database");
  });

  it("falls back when the error body is empty or non-JSON", async () => {
    const client = await loadClient();
    const response = new Response("not-json", { status: 500 });
    const error = await client.parseApiError(response);
    assert.ok(error instanceof client.ApiError);
    assert.equal(error.statusCode, 500);
    assert.equal(error.code, "REQUEST_FAILED");
  });

  it("normalizes network/fetch failures as API_UNREACHABLE", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;

    const client = await loadClient();
    await assert.rejects(
      () => client.apiFetch("/api/example"),
      (error: unknown) => {
        assert.ok(error instanceof client.ApiError);
        assert.equal(error.code, "API_UNREACHABLE");
        assert.equal(error.statusCode, 503);
        return true;
      },
    );
  });

  it("throws MISSING_API_URL when the API origin is unset", async () => {
    process.env.NEXT_PUBLIC_API_URL = "   ";
    globalThis.fetch = (async () => {
      throw new Error("fetch should not run when API URL is missing");
    }) as typeof fetch;
    const href = new URL("./api-client.ts", import.meta.url).href;
    const client = await import(`${href}?t=${Date.now()}-missing`);
    await assert.rejects(
      () => client.apiFetch("/api/example"),
      (error: unknown) => {
        assert.ok(error instanceof client.ApiError);
        assert.equal(error.code, "MISSING_API_URL");
        return true;
      },
    );
  });
});
