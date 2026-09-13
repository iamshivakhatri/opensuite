import assert from "node:assert/strict";
import { test } from "node:test";

import { createProviderCredentialProbe } from "../credentials/provider-probe.js";

test("verifyApiKey accepts provider models list 200 and rejects 401", async () => {
  const calls: string[] = [];
  const probe = createProviderCredentialProbe(async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    if (auth === "Bearer good-key") {
      return new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }] }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: { message: "bad" } }), {
      status: 401,
    });
  });

  const ok = await probe.verifyApiKey({
    provider: "openai",
    apiKey: "good-key",
  });
  assert.equal(ok.ok, true);
  assert.equal(calls[0], "GET https://api.openai.com/v1/models");

  const bad = await probe.verifyApiKey({
    provider: "openai",
    apiKey: "bad-key",
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) {
    assert.equal(bad.code, "INVALID_API_KEY");
  }
});

test("verifyApiKey uses OpenRouter /key because /models is public", async () => {
  const calls: string[] = [];
  const probe = createProviderCredentialProbe(async (url, init) => {
    calls.push(url);
    const auth = (init?.headers as Record<string, string> | undefined)
      ?.Authorization;
    if (
      url === "https://openrouter.ai/api/v1/key" &&
      auth === "Bearer sk-or-good"
    ) {
      return new Response(JSON.stringify({ data: { label: "sk-or-…" } }), {
        status: 200,
      });
    }
    if (url === "https://openrouter.ai/api/v1/key") {
      return new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
        status: 401,
      });
    }
    // Public models list must not be treated as key proof.
    return new Response(JSON.stringify({ data: [{ id: "openai/gpt-4.1" }] }), {
      status: 200,
    });
  });

  const ok = await probe.verifyApiKey({
    provider: "openrouter",
    apiKey: "sk-or-good",
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(calls, ["https://openrouter.ai/api/v1/key"]);

  const bad = await probe.verifyApiKey({
    provider: "openrouter",
    apiKey: "sk-or-random",
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, "INVALID_API_KEY");
});

test("verifyModel uses retrieve for OpenAI and auth+/list for OpenRouter", async () => {
  const probe = createProviderCredentialProbe(async (url, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    if (url.startsWith("https://api.openai.com/v1/models/")) {
      const id = decodeURIComponent(
        url.slice("https://api.openai.com/v1/models/".length),
      );
      if (id === "gpt-4.1" && headers?.Authorization === "Bearer sk-ok") {
        return new Response(JSON.stringify({ id }), { status: 200 });
      }
      if (headers?.Authorization !== "Bearer sk-ok") {
        return new Response("{}", { status: 401 });
      }
      return new Response("{}", { status: 404 });
    }
    if (url === "https://openrouter.ai/api/v1/key") {
      if (headers?.Authorization === "Bearer sk-or") {
        return new Response(JSON.stringify({ data: { label: "ok" } }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 401 });
    }
    if (url === "https://openrouter.ai/api/v1/models") {
      return new Response(
        JSON.stringify({ data: [{ id: "openai/gpt-4.1" }] }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 500 });
  });

  const openaiOk = await probe.verifyModel({
    provider: "openai",
    apiKey: "sk-ok",
    model: "gpt-4.1",
  });
  assert.equal(openaiOk.ok, true);

  const openaiMissing = await probe.verifyModel({
    provider: "openai",
    apiKey: "sk-ok",
    model: "nope",
  });
  assert.equal(openaiMissing.ok, false);
  if (!openaiMissing.ok) assert.equal(openaiMissing.code, "INVALID_MODEL");

  const orOk = await probe.verifyModel({
    provider: "openrouter",
    apiKey: "sk-or",
    model: "openai/gpt-4.1",
  });
  assert.equal(orOk.ok, true);

  const orMissing = await probe.verifyModel({
    provider: "openrouter",
    apiKey: "sk-or",
    model: "openai/missing",
  });
  assert.equal(orMissing.ok, false);
  if (!orMissing.ok) assert.equal(orMissing.code, "INVALID_MODEL");

  const orBadKey = await probe.verifyModel({
    provider: "openrouter",
    apiKey: "sk-or-fake",
    model: "openai/gpt-4.1",
  });
  assert.equal(orBadKey.ok, false);
  if (!orBadKey.ok) assert.equal(orBadKey.code, "INVALID_API_KEY");
});

test("verifyApiKey uses Anthropic x-api-key header", async () => {
  let sawKey: string | undefined;
  let sawVersion: string | undefined;
  const probe = createProviderCredentialProbe(async (_url, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    sawKey = headers?.["x-api-key"];
    sawVersion = headers?.["anthropic-version"];
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  });

  const result = await probe.verifyApiKey({
    provider: "anthropic",
    apiKey: "sk-ant-test",
  });
  assert.equal(result.ok, true);
  assert.equal(sawKey, "sk-ant-test");
  assert.equal(sawVersion, "2023-06-01");
});
