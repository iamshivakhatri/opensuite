import { and, asc, eq, gte, lte, sql } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type {
  ModelUsageAggregate,
  ModelUsageEvent,
  RecordModelUsageInput,
} from "./types.js";

function toEvent(row: {
  id: string;
  userId: string;
  provider: ModelUsageEvent["provider"];
  model: string;
  credentialSource: ModelUsageEvent["credentialSource"];
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningTokens: number | null;
  agentRunId: string | null;
  createdAt: Date;
}): ModelUsageEvent {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    model: row.model,
    credentialSource: row.credentialSource,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedInputTokens: row.cachedInputTokens,
    reasoningTokens: row.reasoningTokens,
    agentRunId: row.agentRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Append-only persistence for model usage events. No update/delete. */
export function createModelUsageRepository(db: Db) {
  return {
    async insert(input: RecordModelUsageInput): Promise<ModelUsageEvent> {
      const [row] = await db
        .insert(schema.modelUsageEvent)
        .values({
          userId: input.userId,
          provider: input.provider,
          model: input.model,
          credentialSource: input.credentialSource,
          inputTokens: input.tokens.inputTokens,
          outputTokens: input.tokens.outputTokens,
          cachedInputTokens: input.tokens.cachedInputTokens,
          reasoningTokens: input.tokens.reasoningTokens,
          agentRunId: input.agentRunId ?? null,
        })
        .returning();
      if (!row) {
        throw new Error("Unable to record model usage event");
      }
      return toEvent(row);
    },

    async listForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
      limit?: number;
    }): Promise<ModelUsageEvent[]> {
      const conditions = [eq(schema.modelUsageEvent.userId, input.userId)];
      if (input.from) {
        conditions.push(gte(schema.modelUsageEvent.createdAt, input.from));
      }
      if (input.to) {
        conditions.push(lte(schema.modelUsageEvent.createdAt, input.to));
      }
      const rows = await db
        .select()
        .from(schema.modelUsageEvent)
        .where(and(...conditions))
        .orderBy(asc(schema.modelUsageEvent.createdAt))
        .limit(input.limit ?? 100);
      return rows.map(toEvent);
    },

    async aggregateForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
    }): Promise<ModelUsageAggregate> {
      const conditions = [eq(schema.modelUsageEvent.userId, input.userId)];
      if (input.from) {
        conditions.push(gte(schema.modelUsageEvent.createdAt, input.from));
      }
      if (input.to) {
        conditions.push(lte(schema.modelUsageEvent.createdAt, input.to));
      }
      const [row] = await db
        .select({
          eventCount: sql<number>`count(*)::int`,
          inputTokens: sql<number>`coalesce(sum(${schema.modelUsageEvent.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${schema.modelUsageEvent.outputTokens}), 0)::int`,
          cachedInputTokens: sql<number>`coalesce(sum(${schema.modelUsageEvent.cachedInputTokens}), 0)::int`,
          reasoningTokens: sql<number>`coalesce(sum(${schema.modelUsageEvent.reasoningTokens}), 0)::int`,
        })
        .from(schema.modelUsageEvent)
        .where(and(...conditions));
      return {
        eventCount: row?.eventCount ?? 0,
        inputTokens: row?.inputTokens ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        cachedInputTokens: row?.cachedInputTokens ?? 0,
        reasoningTokens: row?.reasoningTokens ?? 0,
      };
    },
  };
}

export type ModelUsageRepository = ReturnType<typeof createModelUsageRepository>;
