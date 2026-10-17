import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";

import { registerAgentRoutes } from "./agent.js";

test("GET messages includes attachment metadata for the page", async () => {
  const app = Fastify();
  const threadId = randomUUID();
  const workspaceId = randomUUID();
  const attachmentId = randomUUID();
  const messageId = randomUUID();
  const requestedIds: string[][] = [];

  registerAgentRoutes(app, {
    auth: {
      api: {
        getSession: async ({ headers }) => {
          const id = headers.get("x-test-user");
          return id
            ? { user: { id, name: id, email: `${id}@example.com` }, session: {} }
            : null;
        },
      },
    },
    persistence: {
      listMessagesPageForThread: async () => ({
        messages: [
          {
            id: messageId,
            threadId,
            role: "user" as const,
            content: "Use these sources",
            attachmentIds: [attachmentId],
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        hasMore: false,
        oldestCursor: null,
      }),
      getLatestRunForThread: async () => null,
      listRunsForResultMessages: async () => [],
      getOwnedThread: async () => ({
        id: threadId,
        workspaceId,
        documentId: null,
        createdByUserId: "owner",
        title: "Attachments",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
      }),
    } as never,
    runManager: {} as never,
    webOrigins: [],
    rateLimiter: {} as never,
    chatAttachments: {
      metadataForIds: async (input) => {
        requestedIds.push([...input.attachmentIds]);
        assert.equal(input.workspaceId, workspaceId);
        assert.equal(input.userId, "owner");
        return [
          {
            id: attachmentId,
            workspaceId,
            threadId,
            messageId,
            kind: "file" as const,
            filename: "notes.txt",
            mediaType: "text/plain",
            sizeBytes: 12,
            sha256: "abc",
            status: "bound" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            boundAt: "2026-01-01T00:00:01.000Z",
          },
        ];
      },
    },
  });

  try {
    const response = await app.inject({
      url: `/api/agent/threads/${threadId}/messages`,
      headers: { "x-test-user": "owner" },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      messages: Array<{ attachmentIds?: string[] }>;
      attachments?: Array<{ id: string; filename: string }>;
    };
    assert.deepEqual(body.messages[0]?.attachmentIds, [attachmentId]);
    assert.equal(body.attachments?.length, 1);
    assert.equal(body.attachments?.[0]?.filename, "notes.txt");
    assert.deepEqual(requestedIds, [[attachmentId]]);
  } finally {
    await app.close();
  }
});

test("GET messages omits attachments when the page has none", async () => {
  const app = Fastify();
  const threadId = randomUUID();
  let metadataCalls = 0;

  registerAgentRoutes(app, {
    auth: {
      api: {
        getSession: async ({ headers }) => {
          const id = headers.get("x-test-user");
          return id
            ? { user: { id, name: id, email: `${id}@example.com` }, session: {} }
            : null;
        },
      },
    },
    persistence: {
      listMessagesPageForThread: async () => ({
        messages: [
          {
            id: randomUUID(),
            threadId,
            role: "user" as const,
            content: "Hello",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        hasMore: false,
        oldestCursor: null,
      }),
      getLatestRunForThread: async () => null,
      listRunsForResultMessages: async () => [],
      getOwnedThread: async () => {
        throw new Error("should not load thread for empty attachment ids");
      },
    } as never,
    runManager: {} as never,
    webOrigins: [],
    rateLimiter: {} as never,
    chatAttachments: {
      metadataForIds: async () => {
        metadataCalls += 1;
        return [];
      },
    },
  });

  try {
    const response = await app.inject({
      url: `/api/agent/threads/${threadId}/messages`,
      headers: { "x-test-user": "owner" },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { attachments?: unknown[] };
    assert.equal(body.attachments, undefined);
    assert.equal(metadataCalls, 0);
  } finally {
    await app.close();
  }
});
