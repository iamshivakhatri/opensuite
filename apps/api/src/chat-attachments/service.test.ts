import "../load-env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { createDbClient, schema } from "@opensuite/db";
import { eq } from "drizzle-orm";
import { createMemoryObjectStorage } from "../storage/index.js";
import { createWorkspaceService } from "../workspaces/service.js";
import { createStorageAccountingService } from "../storage-accounting/service.js";
import { createChatAttachmentService } from "./service.js";
import { registerChatAttachmentRoutes } from "../routes/chat-attachments.js";
import { createAgentPersistenceService } from "../agent/persistence.js";

const pdf = Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const txt = Buffer.from("hello attachment");
const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

test(
  "chat attachments upload/bind/auth/quota without creating documents",
  { skip: process.env.RUN_CHAT_ATTACHMENT_DB_TESTS !== "true" && process.env.RUN_BRAND_DB_TESTS !== "true" },
  async () => {
    assert.ok(process.env.DATABASE_URL);
    const admin = createDbClient({ databaseUrl: process.env.DATABASE_URL });
    const testSchema = `chat_att_${randomUUID().replaceAll("-", "")}`;
    const quoted = `"${testSchema}"`;
    await admin.pool.query(`CREATE SCHEMA ${quoted}`);
    const url = new URL(process.env.DATABASE_URL);
    url.searchParams.set("options", `-c search_path=${testSchema}`);
    const client = createDbClient({ databaseUrl: url.toString() });
    const app = Fastify();
    try {
      const folder = new URL("../../../../packages/db/migrations/", import.meta.url);
      const journal = JSON.parse(
        await readFile(new URL("meta/_journal.json", folder), "utf8"),
      ) as { entries: { tag: string }[] };
      for (const { tag } of journal.entries) {
        await client.pool.query(
          (await readFile(new URL(`${tag}.sql`, folder), "utf8")).replaceAll(
            '"public"',
            quoted,
          ),
        );
      }
      const alice = `alice-${randomUUID()}`;
      const bob = `bob-${randomUUID()}`;
      await client.db.insert(schema.user).values(
        [alice, bob].map((id) => ({
          id,
          name: id,
          email: `${id}@example.com`,
        })),
      );
      const [workspace, other] = await client.db
        .insert(schema.workspace)
        .values([
          { ownerUserId: alice, name: "Attach test" },
          { ownerUserId: bob, name: "Other" },
        ])
        .returning();
      assert.ok(workspace && other);
      const storage = createMemoryObjectStorage();
      const accounting = createStorageAccountingService(client.db, 10 * 1024);
      const workspaces = createWorkspaceService(client.db, storage, accounting);
      const attachments = createChatAttachmentService(
        client.db,
        storage,
        workspaces,
        accounting,
        { maxBytes: 10 * 1024, stagedTtlMs: 24 * 60 * 60 * 1000 },
      );
      const persistence = createAgentPersistenceService(client.db);
      await app.register(multipart);
      registerChatAttachmentRoutes(app, {
        api: {
          getSession: async ({ headers }) => {
            const id = headers.get("x-test-user");
            return id === alice || id === bob
              ? {
                  user: { id, name: id, email: `${id}@example.com` },
                  session: {},
                }
              : null;
          },
        },
      }, attachments);

      const workspaceId = workspace.id;
      const otherId = other.id;
      const headers = { "x-test-user": alice };
      async function upload(name: string, bytes: Buffer, threadId?: string) {
        const boundary = "chatatt";
        const payload = Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
          ),
          bytes,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        const query = threadId ? `?threadId=${threadId}` : "";
        return app.inject({
          method: "POST",
          url: `/api/workspaces/${workspaceId}/chat-attachments${query}`,
          headers: {
            ...headers,
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload,
        });
      }

      const pdfRes = await upload("notes.pdf", pdf);
      assert.equal(pdfRes.statusCode, 201);
      const pdfAtt = (pdfRes.json() as { attachment: { id: string; status: string } }).attachment;
      assert.equal(pdfAtt.status, "staged");

      for (const [name, bytes] of [
        ["readme.txt", txt],
        ["readme.md", Buffer.from("# hi")],
        ["chart.png", png],
        ["photo.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])],
        ["brief.docx", docx],
      ] as const) {
        const res = await upload(name, bytes);
        assert.equal(res.statusCode, 201, name);
      }

      const docs = await client.db.select({ id: schema.document.id }).from(schema.document);
      assert.equal(docs.length, 0, "chat attachments must not create workspace documents");

      const bobRes = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspaceId}/chat-attachments/${pdfAtt.id}/meta`,
        headers: { "x-test-user": bob },
      });
      assert.equal(bobRes.statusCode, 404);

      const otherRes = await app.inject({
        method: "GET",
        url: `/api/workspaces/${otherId}/chat-attachments/${pdfAtt.id}/meta`,
        headers,
      });
      assert.equal(otherRes.statusCode, 404);

      const thread = await persistence.createThread({
        workspaceId,
        ownerUserId: alice,
        createdByUserId: alice,
      });
      const message = await persistence.appendMessage({
        threadId: thread.id,
        ownerUserId: alice,
        role: "user",
        content: "Use the PDF",
        attachmentIds: [pdfAtt.id],
      });
      const bound = await attachments.bindToMessage({
        workspaceId,
        userId: alice,
        threadId: thread.id,
        messageId: message.id,
        attachmentIds: [pdfAtt.id],
      });
      assert.equal(bound[0]?.status, "bound");
      assert.equal(bound[0]?.threadId, thread.id);
      assert.equal(bound[0]?.messageId, message.id);
      const cacheScope = { workspaceId, userId: alice, threadId: thread.id, attachmentId: pdfAtt.id };
      const pdfMeta = await attachments.get(cacheScope);
      assert.deepEqual((await attachments.list({ ...cacheScope, status: "bound", mentionedIn: `Use ${pdfMeta.filename.toUpperCase()}.` })).map(row => row.id), [pdfAtt.id]);
      assert.deepEqual((await attachments.list({ ...cacheScope, status: "bound", mentionedIn: `Use attachment ${pdfAtt.id}.` })).map(row => row.id), [pdfAtt.id]);
      assert.deepEqual(await attachments.list({ ...cacheScope, status: "bound", mentionedIn: "No named source" }), []);
      await assert.rejects(attachments.list({ ...cacheScope, userId: bob, status: "bound", mentionedIn: pdfMeta.filename }), /not found/i);
      await attachments.saveExtraction({ ...cacheScope, bytes: Buffer.from('{"cached":"source evidence"}') });
      assert.equal((await attachments.readExtraction(cacheScope))?.toString(), '{"cached":"source evidence"}');
      await assert.rejects(attachments.readExtraction({ ...cacheScope, userId: bob }), /not found/i);

      // Same-thread re-reference must not fail or duplicate bind side effects.
      const again = await attachments.bindToMessage({
        workspaceId,
        userId: alice,
        threadId: thread.id,
        messageId: message.id,
        attachmentIds: [pdfAtt.id],
      });
      assert.equal(again[0]?.id, pdfAtt.id);

      const otherThread = await persistence.createThread({
        workspaceId,
        ownerUserId: alice,
        createdByUserId: alice,
      });
      await assert.rejects(attachments.readExtraction({ ...cacheScope, threadId: otherThread.id }), /not found/i);
      assert.deepEqual(await attachments.list({ ...cacheScope, threadId: otherThread.id, status: "bound", mentionedIn: pdfMeta.filename }), []);
      const otherMessage = await persistence.appendMessage({
        threadId: otherThread.id,
        ownerUserId: alice,
        role: "user",
        content: "nope",
      });
      await assert.rejects(
        () =>
          attachments.bindToMessage({
            workspaceId,
            userId: alice,
            threadId: otherThread.id,
            messageId: otherMessage.id,
            attachmentIds: [pdfAtt.id],
          }),
        /another thread/,
      );

      const staged = await attachments.upload({
        workspaceId,
        userId: alice,
        filename: "temp.txt",
        bytes: Buffer.from("temp"),
      });
      await assert.rejects(attachments.getBound({ ...cacheScope, attachmentId: staged.id }), /not found/i);
      await attachments.bindToMessage({ workspaceId, userId: alice, threadId: thread.id, messageId: message.id, attachmentIds: [staged.id] });
      await attachments.saveExtraction({ ...cacheScope, attachmentId: staged.id, bytes: Buffer.from('temporary cache') });
      const deletedCacheKey = `workspaces/${workspaceId}/chat-attachments/${staged.id}/extraction.json`;
      assert.equal(storage.objects.has(deletedCacheKey), true);
      await attachments.remove({ workspaceId, userId: alice, attachmentId: staged.id });
      assert.equal(storage.objects.has(deletedCacheKey), false);
      await assert.rejects(attachments.readExtraction({ ...cacheScope, attachmentId: staged.id }), /not found/i);
      await assert.rejects(
        () =>
          attachments.get({
            workspaceId,
            userId: alice,
            attachmentId: staged.id,
          }),
        /not found/i,
      );

      const tinyQuota = createChatAttachmentService(
        client.db,
        storage,
        workspaces,
        createStorageAccountingService(client.db, 8),
        { maxBytes: 10 * 1024 },
      );
      await assert.rejects(
        () =>
          tinyQuota.upload({
            workspaceId,
            userId: alice,
            filename: "big.txt",
            bytes: Buffer.from("0123456789"),
          }),
        /quota/i,
      );

      // Expire staged: backdate a staged row and reclaim.
      const abandon = await attachments.upload({
        workspaceId,
        userId: alice,
        filename: "old.txt",
        bytes: Buffer.from("old"),
      });
      await client.db
        .update(schema.chatAttachment)
        .set({ createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where(eq(schema.chatAttachment.id, abandon.id));
      const expired = await createChatAttachmentService(
        client.db,
        storage,
        workspaces,
        accounting,
        { stagedTtlMs: 24 * 60 * 60 * 1000 },
      ).expireStaged({ workspaceId, userId: alice });
      assert.ok(expired >= 1);
      await assert.rejects(
        () =>
          attachments.read({
            workspaceId,
            userId: alice,
            attachmentId: abandon.id,
          }),
        /not found/i,
      );

      const expected = await accounting.expectedUsage(alice);
      const status = await accounting.status(alice);
      assert.equal(status.usedBytes, expected);

      await client.db
        .update(schema.workspace)
        .set({ deletedAt: new Date() })
        .where(eq(schema.workspace.id, workspaceId));
      await workspaces.purge({ workspaceId, ownerUserId: alice });
      const remaining = await client.db
        .select({ id: schema.chatAttachment.id })
        .from(schema.chatAttachment)
        .where(eq(schema.chatAttachment.workspaceId, workspaceId));
      assert.equal(remaining.length, 0);
      assert.ok([...storage.objects.keys()].every(key => !key.startsWith(`workspaces/${workspaceId}/chat-attachments/`)));
      assert.equal((await accounting.status(alice)).usedBytes, 0);
    } finally {
      await app.close();
      await client.close();
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      await admin.close();
    }
  },
);
