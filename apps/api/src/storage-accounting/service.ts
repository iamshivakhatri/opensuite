import { eq, sql } from "drizzle-orm";
import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

export class StorageQuotaError extends Error {
  constructor(readonly requiredBytes: number, readonly remainingBytes: number) {
    super("Storage quota exceeded");
  }
}

export function createStorageAccountingService(db: Db, quotaBytes: number) {
  async function reserve(tx: Db, userId: string, bytes: number): Promise<void> {
    await tx.insert(schema.userStorageAccount).values({ userId }).onConflictDoNothing();
    const [updated] = await tx
      .update(schema.userStorageAccount)
      .set({ usedBytes: sql`${schema.userStorageAccount.usedBytes} + ${bytes}` })
      .where(sql`${schema.userStorageAccount.userId} = ${userId} and ${schema.userStorageAccount.usedBytes} + ${bytes} <= ${quotaBytes}`)
      .returning({ usedBytes: schema.userStorageAccount.usedBytes });
    if (updated) return;
    const [current] = await tx.select({ usedBytes: schema.userStorageAccount.usedBytes }).from(schema.userStorageAccount).where(eq(schema.userStorageAccount.userId, userId));
    throw new StorageQuotaError(bytes, Math.max(0, quotaBytes - (current?.usedBytes ?? 0)));
  }

  return {
    reserve,
    async status(userId: string) {
      const [account] = await db.select().from(schema.userStorageAccount).where(eq(schema.userStorageAccount.userId, userId));
      const usedBytes = account?.usedBytes ?? 0;
      return { usedBytes, quotaBytes, remainingBytes: Math.max(0, quotaBytes - usedBytes) };
    },
    async expectedUsage(userId: string) {
      const [row] = await db.select({ usedBytes: sql<number>`coalesce(sum(${schema.documentVersion.sizeBytes}), 0)::bigint` }).from(schema.documentVersion).innerJoin(schema.document, eq(schema.documentVersion.documentId, schema.document.id)).innerJoin(schema.workspace, eq(schema.document.workspaceId, schema.workspace.id)).where(eq(schema.workspace.ownerUserId, userId));
      return row?.usedBytes ?? 0;
    },
    async reconcile(userId: string) {
      const [status, expectedBytes] = await Promise.all([
        this.status(userId),
        this.expectedUsage(userId),
      ]);
      return { usedBytes: status.usedBytes, expectedBytes, matches: status.usedBytes === expectedBytes };
    },
  };
}
export type StorageAccountingService = ReturnType<typeof createStorageAccountingService>;
