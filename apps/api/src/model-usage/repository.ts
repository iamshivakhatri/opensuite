import { and, asc, eq, gte, lte, sql } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

import type {
  ModelUsageAggregate,
  ModelUsageCostAggregate,
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
  costMicros: number | null;
  costCurrency: string | null;
  costSource: string | null;
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
    costMicros: row.costMicros,
    costCurrency: row.costCurrency,
    costSource: row.costSource,
    agentRunId: row.agentRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

function emptyCostBucket() {
  return {
    eventCount: 0,
    pricedEventCount: 0,
    costMicros: null as number | null,
  };
}

/** Append-only persistence for model usage events. No update/delete. */
export function createModelUsageRepository(db: Db) {
  return {
    async insert(input: RecordModelUsageInput): Promise<ModelUsageEvent> {
      const cost = input.cost ?? {
        costMicros: null,
        costCurrency: null,
        costSource: null,
      };
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
          costMicros: cost.costMicros,
          costCurrency: cost.costCurrency,
          costSource: cost.costSource,
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

    /**
     * Sum stored cost_micros snapshots only — never re-price rows.
     */
    async aggregateCostForUser(input: {
      userId: string;
      from?: Date;
      to?: Date;
      credentialSource?: ModelUsageEvent["credentialSource"];
    }): Promise<ModelUsageCostAggregate> {
      const conditions = [eq(schema.modelUsageEvent.userId, input.userId)];
      if (input.from) {
        conditions.push(gte(schema.modelUsageEvent.createdAt, input.from));
      }
      if (input.to) {
        conditions.push(lte(schema.modelUsageEvent.createdAt, input.to));
      }
      if (input.credentialSource) {
        conditions.push(
          eq(schema.modelUsageEvent.credentialSource, input.credentialSource),
        );
      }

      const rows = await db
        .select({
          credentialSource: schema.modelUsageEvent.credentialSource,
          costMicros: schema.modelUsageEvent.costMicros,
          costCurrency: schema.modelUsageEvent.costCurrency,
        })
        .from(schema.modelUsageEvent)
        .where(and(...conditions));

      const byok = emptyCostBucket();
      const managed = emptyCostBucket();
      let pricedEventCount = 0;
      let currency: string | null = null;

      for (const row of rows) {
        const bucket = row.credentialSource === "byok" ? byok : managed;
        bucket.eventCount += 1;
        if (row.costMicros !== null) {
          bucket.pricedEventCount += 1;
          pricedEventCount += 1;
          bucket.costMicros = (bucket.costMicros ?? 0) + row.costMicros;
          currency ??= row.costCurrency;
        }
      }

      const eventCount = rows.length;
      return {
        eventCount,
        pricedEventCount,
        unpricedEventCount: eventCount - pricedEventCount,
        costMicros:
          pricedEventCount > 0
            ? (byok.costMicros ?? 0) + (managed.costMicros ?? 0)
            : null,
        costCurrency: pricedEventCount > 0 ? currency : null,
        byCredentialSource: { byok, managed },
      };
    },
  };
}

export type ModelUsageRepository = ReturnType<typeof createModelUsageRepository>;
