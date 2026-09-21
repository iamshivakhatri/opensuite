import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient, schema } from "@opensuite/db";

import { buildApp } from "../app.js";
import type { AppDependencies } from "../app.js";
import type { AuthenticatedUser } from "../auth/session.js";
import { createAgentPersistenceService } from "../agent/persistence.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import { testS3Env } from "./support/test-env.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl ?? "postgresql://user:pass@localhost:5432/opensuite",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:3001",
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "OpenSuite <noreply@example.com>",
    AGENT_MODEL_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "sk-or-v1-test-key",
    OPENROUTER_MODEL: "test/test-model",
    ...testS3Env,
  });
}

function mockAuth(user: AuthenticatedUser): AppDependencies["auth"] {
  return {
    handler: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    api: {
      getSession: async () => ({ user, session: { id: "mock-session" } }),
    },
  };
}

async function seedUser(
  db: ReturnType<typeof createDbClient>["db"],
  label: string,
): Promise<AuthenticatedUser> {
  const id = randomUUID();
  const email = `agent-pagination-${label}-${id}@example.com`;
  await db.insert(schema.user).values({
    id,
    name: label,
    email,
    emailVerified: true,
  });
  return { id, name: label, email };
}

async function seedWorkspace(
  db: ReturnType<typeof createDbClient>["db"],
  ownerUserId: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.workspace)
    .values({ ownerUserId, name: "Pagination WS" })
    .returning({ id: schema.workspace.id });
  assert.ok(row);
  return row.id;
}

/** Appends `count` alternating user/assistant messages, oldest first. */
async function seedMessages(
  agents: ReturnType<typeof createAgentPersistenceService>,
  threadId: string,
  ownerUserId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const message = await agents.appendMessage({
      threadId,
      ownerUserId,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    });
    ids.push(message.id);
  }
  return ids;
}

test(
  "GET /messages: cursor pagination contract",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const db = dbClient.db;
    const agents = createAgentPersistenceService(db);

    try {
      const alice = await seedUser(db, "alice");
      const bob = await seedUser(db, "bob");
      const workspaceId = await seedWorkspace(db, alice.id);
      const thread = await agents.createThread({
        workspaceId,
        ownerUserId: alice.id,
        createdByUserId: alice.id,
        title: "Pagination thread",
      });
      const otherThread = await agents.createThread({
        workspaceId,
        ownerUserId: alice.id,
        createdByUserId: alice.id,
        title: "Other thread",
      });

      // 120 messages so the 50-message default page needs >1 fetch to exhaust.
      const allIds = await seedMessages(agents, thread.id, alice.id, 120);
      await agents.appendMessage({
        threadId: otherThread.id,
        ownerUserId: alice.id,
        role: "user",
        content: "belongs to a different thread",
      });

      const app = await buildApp(testConfig(), {
        auth: mockAuth(alice),
        db,
        storage: createMemoryObjectStorage(),
      });

      try {
        // 1. no cursor -> latest page only (default 50), newest 50 ids.
        const latest = await app.inject({
          method: "GET",
          url: `/api/agent/threads/${thread.id}/messages`,
        });
        assert.equal(latest.statusCode, 200);
        const latestBody = latest.json();
        assert.equal(latestBody.messages.length, 50);
        assert.deepEqual(
          latestBody.messages.map((m: { id: string }) => m.id),
          allIds.slice(70, 120),
        );

        // 2. >page-size thread -> hasMore true.
        assert.equal(latestBody.page.hasMore, true);
        assert.ok(latestBody.page.oldestCursor);

        // 6. messages from other threads excluded — no otherThread content anywhere.
        assert.ok(
          !latestBody.messages.some(
            (m: { content: string }) => m.content.includes("different thread"),
          ),
        );

        // 8. chronological response ordering.
        const createdAts = latestBody.messages.map(
          (m: { createdAt: string }) => m.createdAt,
        );
        const sorted = [...createdAts].sort();
        assert.deepEqual(createdAts, sorted);

        // 3. cursor request -> returns previous page.
        const cursor = latestBody.page.oldestCursor;
        const previous = await app.inject({
          method: "GET",
          url:
            `/api/agent/threads/${thread.id}/messages` +
            `?beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`,
        });
        assert.equal(previous.statusCode, 200);
        const previousBody = previous.json();
        assert.equal(previousBody.messages.length, 50);
        assert.deepEqual(
          previousBody.messages.map((m: { id: string }) => m.id),
          allIds.slice(20, 70),
        );
        assert.equal(previousBody.page.hasMore, true);

        // 9. no duplicates across adjacent pages.
        const latestIdSet = new Set(
          latestBody.messages.map((m: { id: string }) => m.id),
        );
        assert.ok(
          previousBody.messages.every(
            (m: { id: string }) => !latestIdSet.has(m.id),
          ),
        );

        // 4/10. final oldest page -> strict boundary + hasMore false.
        const secondCursor = previousBody.page.oldestCursor;
        const oldest = await app.inject({
          method: "GET",
          url:
            `/api/agent/threads/${thread.id}/messages` +
            `?beforeCreatedAt=${encodeURIComponent(secondCursor.createdAt)}&beforeId=${secondCursor.id}`,
        });
        assert.equal(oldest.statusCode, 200);
        const oldestBody = oldest.json();
        assert.deepEqual(
          oldestBody.messages.map((m: { id: string }) => m.id),
          allIds.slice(0, 20),
        );
        assert.equal(oldestBody.page.hasMore, false);
        assert.equal(oldestBody.page.oldestCursor, undefined);

        // 7. maximum limit enforced.
        const overLimit = await app.inject({
          method: "GET",
          url: `/api/agent/threads/${thread.id}/messages?limit=101`,
        });
        assert.equal(overLimit.statusCode, 400);

        const atMax = await app.inject({
          method: "GET",
          url: `/api/agent/threads/${thread.id}/messages?limit=100`,
        });
        assert.equal(atMax.statusCode, 200);
        assert.equal(atMax.json().messages.length, 100);

        // 5. timestamp ties handled by id — force two messages with the
        // same created_at and verify strict (createdAt, id) ordering holds.
        const tieThread = await agents.createThread({
          workspaceId,
          ownerUserId: alice.id,
          createdByUserId: alice.id,
          title: "Tie thread",
        });
        const tiedAt = new Date();
        const [rowA, rowB] = await db
          .insert(schema.agentMessage)
          .values([
            {
              threadId: tieThread.id,
              role: "user",
              content: "tie A",
              createdAt: tiedAt,
            },
            {
              threadId: tieThread.id,
              role: "assistant",
              content: "tie B",
              createdAt: tiedAt,
            },
          ])
          .returning({ id: schema.agentMessage.id });
        assert.ok(rowA && rowB);
        const [first, second] =
          rowA.id < rowB.id ? [rowA, rowB] : [rowB, rowA];

        const tiePage = await app.inject({
          method: "GET",
          url: `/api/agent/threads/${tieThread.id}/messages`,
        });
        const tieBody = tiePage.json();
        assert.deepEqual(
          tieBody.messages.map((m: { id: string }) => m.id),
          [first.id, second.id],
        );

        const tieBefore = await app.inject({
          method: "GET",
          url:
            `/api/agent/threads/${tieThread.id}/messages` +
            `?beforeCreatedAt=${encodeURIComponent(tiedAt.toISOString())}&beforeId=${second.id}`,
        });
        const tieBeforeBody = tieBefore.json();
        assert.deepEqual(
          tieBeforeBody.messages.map((m: { id: string }) => m.id),
          [first.id],
        );

        // 22/23. Large-thread proof: initial payload/rendered count stays
        // bounded regardless of lifetime thread length (1,000 messages here).
        const bigThread = await agents.createThread({
          workspaceId,
          ownerUserId: alice.id,
          createdByUserId: alice.id,
          title: "Big thread",
        });
        const bigCount = 1000;
        const base = Date.now() - bigCount * 1000;
        const bigRows = Array.from({ length: bigCount }, (_, i) => ({
          threadId: bigThread.id,
          role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
          content: `big message ${i}`,
          createdAt: new Date(base + i * 1000),
        }));
        // Batch insert (in chunks) — direct schema insert, not per-message
        // appendMessage round trips, to keep fixture generation cheap.
        const chunkSize = 200;
        for (let i = 0; i < bigRows.length; i += chunkSize) {
          await db.insert(schema.agentMessage).values(bigRows.slice(i, i + chunkSize));
        }

        const bigLatest = await app.inject({
          method: "GET",
          url: `/api/agent/threads/${bigThread.id}/messages`,
        });
        assert.equal(bigLatest.statusCode, 200);
        const bigLatestBody = bigLatest.json();
        // Initial payload stays ~50 rows regardless of the 1,000-message thread.
        assert.equal(bigLatestBody.messages.length, 50);
        assert.equal(bigLatestBody.page.hasMore, true);
        assert.equal(
          bigLatestBody.messages[0].content,
          `big message ${bigCount - 50}`,
        );
        assert.equal(
          bigLatestBody.messages[49].content,
          `big message ${bigCount - 1}`,
        );

        // One earlier page fetch loads only another bounded page.
        const bigCursor = bigLatestBody.page.oldestCursor;
        const bigOlder = await app.inject({
          method: "GET",
          url:
            `/api/agent/threads/${bigThread.id}/messages` +
            `?beforeCreatedAt=${encodeURIComponent(bigCursor.createdAt)}&beforeId=${bigCursor.id}`,
        });
        const bigOlderBody = bigOlder.json();
        assert.equal(bigOlderBody.messages.length, 50);
        assert.equal(
          bigOlderBody.messages[0].content,
          `big message ${bigCount - 100}`,
        );

        // Cross-owner request must not see another user's thread.
        const bobApp = await buildApp(testConfig(), {
          auth: mockAuth(bob),
          db,
          storage: createMemoryObjectStorage(),
        });
        try {
          const forbidden = await bobApp.inject({
            method: "GET",
            url: `/api/agent/threads/${thread.id}/messages`,
          });
          assert.equal(forbidden.statusCode, 404);
        } finally {
          await bobApp.close();
        }
      } finally {
        await app.close();
      }
    } finally {
      await dbClient.close();
    }
  },
);
