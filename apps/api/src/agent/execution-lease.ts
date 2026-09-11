import { randomUUID } from "node:crypto";

import { and, eq, lte } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

export const AGENT_EXECUTION_LEASE_MS = 5 * 60_000;
export const AGENT_EXECUTION_LEASE_RENEW_MS = 60_000;

export interface AgentExecutionLease {
  readonly userId: string;
  readonly leaseId: string;
}

export interface AgentExecutionLeaseService {
  acquire(userId: string): Promise<AgentExecutionLease | null>;
  renew(lease: AgentExecutionLease): Promise<boolean>;
  release(lease: AgentExecutionLease): Promise<boolean>;
}

/** One row per user; conflict update only takes an expired row. */
export function createAgentExecutionLeaseService(
  db: Db,
  now: () => Date = () => new Date(),
): AgentExecutionLeaseService {
  return {
    async acquire(userId) {
      const acquiredAt = now();
      const lease = { userId, leaseId: randomUUID() };
      const [row] = await db
        .insert(schema.agentExecutionLease)
        .values({
          ...lease,
          acquiredAt,
          expiresAt: new Date(acquiredAt.getTime() + AGENT_EXECUTION_LEASE_MS),
        })
        .onConflictDoUpdate({
          target: schema.agentExecutionLease.userId,
          set: {
            leaseId: lease.leaseId,
            acquiredAt,
            expiresAt: new Date(acquiredAt.getTime() + AGENT_EXECUTION_LEASE_MS),
          },
          where: lte(schema.agentExecutionLease.expiresAt, acquiredAt),
        })
        .returning({ leaseId: schema.agentExecutionLease.leaseId });
      return row ? lease : null;
    },

    async renew(lease) {
      const renewedAt = now();
      const rows = await db
        .update(schema.agentExecutionLease)
        .set({ expiresAt: new Date(renewedAt.getTime() + AGENT_EXECUTION_LEASE_MS) })
        .where(
          and(
            eq(schema.agentExecutionLease.userId, lease.userId),
            eq(schema.agentExecutionLease.leaseId, lease.leaseId),
          ),
        )
        .returning({ userId: schema.agentExecutionLease.userId });
      return rows.length === 1;
    },

    async release(lease) {
      const rows = await db
        .delete(schema.agentExecutionLease)
        .where(
          and(
            eq(schema.agentExecutionLease.userId, lease.userId),
            eq(schema.agentExecutionLease.leaseId, lease.leaseId),
          ),
        )
        .returning({ userId: schema.agentExecutionLease.userId });
      return rows.length === 1;
    },
  };
}
