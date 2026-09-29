import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QueryClient } from "@tanstack/react-query";

/**
 * Verifies the cache contract our query-keys helpers rely on:
 * shared keys + staleTime prevent duplicate network work across consumers.
 */
describe("frontend query cache reuse", () => {
  it("reuses document fetch within staleTime across consumers", async () => {
    let calls = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const documentId = "doc-1";
    const options = {
      queryKey: ["documents", documentId] as const,
      queryFn: async () => {
        calls += 1;
        return { id: documentId };
      },
      staleTime: 30_000,
    };

    await client.fetchQuery(options);
    await client.fetchQuery(options);
    assert.equal(calls, 1);

    await client.invalidateQueries({ queryKey: ["documents", documentId] });
    await client.fetchQuery(options);
    assert.equal(calls, 2);
  });

  it("reuses workspace document list across simultaneous consumers", async () => {
    let calls = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const workspaceId = "ws-1";
    const options = {
      queryKey: ["workspaces", workspaceId, "documents"] as const,
      queryFn: async () => {
        calls += 1;
        return [{ id: "doc-1" }];
      },
      staleTime: 60_000,
    };

    await Promise.all([client.fetchQuery(options), client.fetchQuery(options)]);
    assert.equal(calls, 1);
    await client.fetchQuery(options);
    assert.equal(calls, 1);
  });

  it("caches AI preference and provider credentials across remount-style fetches", async () => {
    let preferenceCalls = 0;
    let credentialCalls = 0;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const preference = {
      queryKey: ["ai-preferences"] as const,
      queryFn: async () => {
        preferenceCalls += 1;
        return { credentialSource: "managed" as const };
      },
      staleTime: 5 * 60_000,
    };
    const credentials = {
      queryKey: ["provider-credentials"] as const,
      queryFn: async () => {
        credentialCalls += 1;
        return [];
      },
      staleTime: 5 * 60_000,
    };

    await client.fetchQuery(preference);
    await client.fetchQuery(credentials);
    // Simulate agent panel + settings remounting and re-reading.
    await client.fetchQuery(preference);
    await client.fetchQuery(credentials);
    assert.equal(preferenceCalls, 1);
    assert.equal(credentialCalls, 1);

    client.setQueryData(["ai-preferences"], {
      credentialSource: "byok",
      provider: "openai",
      model: "gpt-4o",
    });
    const cached = client.getQueryData(["ai-preferences"]) as {
      credentialSource: string;
    };
    assert.equal(cached.credentialSource, "byok");
  });
});
