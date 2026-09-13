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
  const href = new URL("./ai-settings-api.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`);
}

describe("AI settings API client", () => {
  it("lists credentials without rendering secrets", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(
        JSON.stringify({
          credentials: [
            {
              provider: "openai",
              connected: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = await loadApi();
    const credentials = await api.listProviderCredentials();
    assert.equal(calls[0]?.url, "http://api.test/api/provider-credentials");
    assert.equal(credentials[0]?.connected, true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(credentials[0], "apiKey"),
      false,
    );
    assert.equal(JSON.stringify(credentials).includes("sk-"), false);
  });

  it("connects a credential via PUT with body only (not URL)", async () => {
    let body = "";
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input);
      body = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          credential: {
            provider: "anthropic",
            connected: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = await loadApi();
    const credential = await api.connectProviderCredential({
      provider: "anthropic",
      apiKey: "sk-test-key",
    });
    assert.equal(credential.connected, true);
    assert.equal(url.includes("sk-test-key"), false);
    assert.match(body, /"apiKey":"sk-test-key"/);
  });

  it("replaces and removes credentials with correct methods", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      methods.push(`${init?.method ?? "GET"} ${String(input)}`);
      if ((init?.method ?? "GET") === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          credential: {
            provider: "openrouter",
            connected: true,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = await loadApi();
    await api.connectProviderCredential({
      provider: "openrouter",
      apiKey: "or-key",
    });
    await api.deleteProviderCredential("openrouter");
    assert.deepEqual(methods, [
      "PUT http://api.test/api/provider-credentials",
      "DELETE http://api.test/api/provider-credentials/openrouter",
    ]);
  });

  it("loads managed catalog and saves exact model id", async () => {
    const bodies: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/ai-models/managed")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                id: "openai/gpt-4.1",
                name: "GPT-4.1",
                author: "openai",
                contextLength: 128000,
                supportedParameters: ["tools"],
                pricing: { prompt: "0.000002", completion: "0.000008" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      bodies.push(String(init?.body ?? ""));
      return new Response(
        JSON.stringify({
          preference: {
            provider: "openrouter",
            model: "openai/gpt-4.1",
            credentialSource: "managed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = await loadApi();
    const models = await api.fetchManagedAiModels();
    assert.equal(models[0]?.id, "openai/gpt-4.1");
    const preference = await api.saveAiPreference({
      credentialSource: "managed",
    });
    assert.equal(preference.model, "openai/gpt-4.1");
    assert.match(bodies[0] ?? "", /"credentialSource":"managed"/);
  });

  it("saves BYOK preference and loads trial status", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/ai-trial")) {
        return new Response(
          JSON.stringify({
            enabled: true,
            originalGrantMicros: 5_000_000,
            balanceMicros: 1_250_000,
            displayGrantCredits: 100,
            exhausted: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      assert.equal(init?.method, "PUT");
      return new Response(
        JSON.stringify({
          preference: {
            provider: "openai",
            model: "gpt-4.1",
            credentialSource: "byok",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = await loadApi();
    const preference = await api.saveAiPreference({
      provider: "openai",
      model: "gpt-4.1",
      credentialSource: "byok",
    });
    assert.equal(preference.credentialSource, "byok");
    const trial = await api.fetchAiTrial();
    assert.equal(trial.balanceMicros, 1_250_000);
    assert.equal(trial.displayGrantCredits, 100);
    assert.equal(trial.exhausted, false);
  });

  it("surfaces catalog failure without inventing models", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            statusCode: 502,
            code: "CATALOG_UNAVAILABLE",
            message: "Managed model catalog is unavailable",
          },
        }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const api = await loadApi();
    await assert.rejects(
      () => api.fetchManagedAiModels(),
      (error: unknown) => {
        assert.ok(error instanceof api.AiApiError);
        assert.equal(error.code, "CATALOG_UNAVAILABLE");
        return true;
      },
    );
  });
});
