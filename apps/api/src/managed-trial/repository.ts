import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";
import type { ManagedTrialAccount } from "./types.js";

function account(row: typeof schema.managedAiTrialAccount.$inferSelect): ManagedTrialAccount {
  return { ...row, blockedAt: row.blockedAt?.toISOString() ?? null };
}

export function createManagedTrialRepository(db: Db) {
  return {
    async get(userId: string): Promise<ManagedTrialAccount | null> {
      const [row] = await db.select().from(schema.managedAiTrialAccount).where(eq(schema.managedAiTrialAccount.userId, userId));
      return row ? account(row) : null;
    },
    async ensure(userId: string, grantMicros: number): Promise<ManagedTrialAccount> {
      await db.insert(schema.managedAiTrialAccount).values({ userId, originalGrantMicros: grantMicros, balanceMicros: grantMicros }).onConflictDoNothing();
      const value = await this.get(userId);
      if (!value) throw new Error("Unable to create managed trial account");
      return value;
    },
    async block(userId: string): Promise<void> {
      await db.update(schema.managedAiTrialAccount).set({ blockedAt: new Date() }).where(eq(schema.managedAiTrialAccount.userId, userId));
    },
    async debit(input: { userId: string; modelUsageEventId: string; costMicros: number }): Promise<ManagedTrialAccount> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select ${schema.managedAiTrialAccount.userId} from ${schema.managedAiTrialAccount} where ${schema.managedAiTrialAccount.userId} = ${input.userId} for update`);
        const [existing] = await tx.select().from(schema.managedAiTrialDebit).where(eq(schema.managedAiTrialDebit.modelUsageEventId, input.modelUsageEventId));
        if (existing) {
          const [current] = await tx.select().from(schema.managedAiTrialAccount).where(eq(schema.managedAiTrialAccount.userId, input.userId));
          if (!current) throw new Error("Managed trial account not found");
          return account(current);
        }
        const [updated] = await tx.update(schema.managedAiTrialAccount).set({ balanceMicros: sql`${schema.managedAiTrialAccount.balanceMicros} - ${input.costMicros}` }).where(eq(schema.managedAiTrialAccount.userId, input.userId)).returning();
        if (!updated) throw new Error("Managed trial account not found");
        await tx.insert(schema.managedAiTrialDebit).values({ userId: input.userId, modelUsageEventId: input.modelUsageEventId, costMicros: input.costMicros, balanceAfterMicros: updated.balanceMicros });
        return account(updated);
      });
    },
  };
}
export type ManagedTrialRepository = ReturnType<typeof createManagedTrialRepository>;
