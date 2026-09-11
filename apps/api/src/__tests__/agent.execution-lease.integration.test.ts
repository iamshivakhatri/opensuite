import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient, schema } from "@opensuite/db";
import { eq } from "drizzle-orm";

import { createAgentExecutionLeaseService } from "../agent/execution-lease.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

test(
  "execution leases atomically limit a user and protect newer tokens",
  { skip: !runDbIntegrationTests || !databaseUrl },
  async () => {
    const client = createDbClient({ databaseUrl: databaseUrl! });
    const userId = randomUUID();
    const otherUserId = randomUUID();
    await client.db.insert(schema.user).values([
      {
        id: userId,
        name: "Lease owner",
        email: `lease-owner-${userId}@example.com`,
        emailVerified: true,
      },
      {
        id: otherUserId,
        name: "Other lease owner",
        email: `lease-other-${otherUserId}@example.com`,
        emailVerified: true,
      },
    ]);

    try {
      const leases = createAgentExecutionLeaseService(client.db);
      const attempts = await Promise.all(
        Array.from({ length: 2 }, () => leases.acquire(userId)),
      );
      const [first] = attempts.filter(Boolean);
      assert.ok(first);
      assert.equal(attempts.filter(Boolean).length, 1);
      assert.ok(await leases.acquire(otherUserId));

      assert.equal(await leases.release(first), true);
      const second = await leases.acquire(userId);
      assert.ok(second);

      await client.db
        .update(schema.agentExecutionLease)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(schema.agentExecutionLease.userId, userId));
      const recovered = await leases.acquire(userId);
      assert.ok(recovered);
      assert.notEqual(recovered.leaseId, second.leaseId);
      assert.equal(await leases.release(second), false);
      assert.equal(await leases.release(recovered), true);
    } finally {
      await client.db.delete(schema.user).where(eq(schema.user.id, userId));
      await client.db.delete(schema.user).where(eq(schema.user.id, otherUserId));
      await client.close();
    }
  },
);
