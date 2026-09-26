import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";

import { registerAgentRoutes } from "./agent.js";

test("working document bytes are available only to the run owner while active", async () => {
  const app = Fastify();
  const runId = randomUUID();
  let active = true;
  registerAgentRoutes(app, {
    auth: { api: { getSession: async ({ headers }) => {
      const id = headers.get("x-test-user");
      return id ? { user: { id, name: id, email: `${id}@example.com` }, session: {} } : null;
    } } },
    persistence: { getRun: async ({ ownerUserId }: { ownerUserId: string }) => ownerUserId === "owner" ? { id: runId } : null } as never,
    runManager: { getWorkingDocument: ({ ownerUserId }: { ownerUserId: string }) => active && ownerUserId === "owner"
      ? { documentId: "doc-1", baseVersionId: "v1", revision: 2, bytes: Buffer.from("preview") }
      : null } as never,
    webOrigins: [],
    rateLimiter: {} as never,
  });
  const url = `/api/agent/runs/${runId}/working-document`;
  try {
    const anonymous = await app.inject({ url });
    assert.equal(anonymous.statusCode, 401);
    const other = await app.inject({ url, headers: { "x-test-user": "other" } });
    assert.equal(other.statusCode, 404);
    const owner = await app.inject({ url, headers: { "x-test-user": "owner" } });
    assert.equal(owner.statusCode, 200);
    assert.equal(owner.body, "preview");
    assert.equal(owner.headers["x-working-revision"], "2");
    assert.equal(owner.headers["cache-control"], "no-store");
    active = false;
    const finished = await app.inject({ url, headers: { "x-test-user": "owner" } });
    assert.equal(finished.statusCode, 404);
  } finally {
    await app.close();
  }
});
