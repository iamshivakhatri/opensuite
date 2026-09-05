import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { and, eq, isNull } from "drizzle-orm";
import { createDbClient, schema } from "@opensuite/db";

import { createAuth } from "../auth/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import {
  createStubEmailSender,
  extractEmailActionUrl,
} from "./support/stub-email-sender.js";
import { multipartFilePayload, testS3Env } from "./support/test-env.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ??
      "test-secret-that-is-at-least-32-characters-long",
    BETTER_AUTH_URL: "http://localhost:3000",
    WEB_ORIGIN: "http://localhost:3001",
    RESEND_API_KEY: "re_test_key_unused_stub_sender_is_injected_instead",
    EMAIL_FROM: "OpenSuite <noreply@example.com>",
    ...testS3Env,
  });
}

async function signUpVerifyAndSignIn(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  emailSender: ReturnType<typeof createStubEmailSender>,
  name: string,
): Promise<{ cookie: string; userId: string }> {
  const email = `doc-${name}-${randomUUID()}@example.com`;
  const password = "password1234";

  const signUp = await app.inject({
    method: "POST",
    url: "/api/auth/sign-up/email",
    headers: {
      "content-type": "application/json",
      origin: config.webOrigin,
    },
    payload: {
      name,
      email,
      password,
      callbackURL: `${config.webOrigin}/sign-in?verified=true`,
    },
  });
  assert.equal(signUp.statusCode, 200, signUp.body);

  const verificationUrl = extractEmailActionUrl(
    emailSender.sent[emailSender.sent.length - 1]!,
  );
  const verifyUrl = new URL(verificationUrl);
  const verify = await app.inject({
    method: "GET",
    url: `${verifyUrl.pathname}${verifyUrl.search}`,
    headers: { origin: config.webOrigin },
  });
  assert.equal(verify.statusCode, 302, verify.body);

  const signIn = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: {
      "content-type": "application/json",
      origin: config.webOrigin,
    },
    payload: { email, password },
  });
  assert.equal(signIn.statusCode, 200, signIn.body);
  const setCookie = signIn.headers["set-cookie"];
  assert.ok(setCookie);
  const cookie = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;

  const me = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { cookie, origin: config.webOrigin },
  });
  assert.equal(me.statusCode, 200, me.body);
  const userId = (me.json() as { user: { id: string } }).user.id;

  return { cookie, userId };
}

async function createWorkspace(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  cookie: string,
  name: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/workspaces",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: config.webOrigin,
    },
    payload: { name },
  });
  assert.equal(response.statusCode, 201, response.body);
  return (response.json() as { workspace: { id: string } }).workspace.id;
}

test(
  "document upload is owner-scoped and persists document + version 1",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const storage = createMemoryObjectStorage();
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage,
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "Alice",
      );
      const bob = await signUpVerifyAndSignIn(app, config, emailSender, "Bob");
      const aliceWorkspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Alice Docs",
      );
      const bobWorkspaceId = await createWorkspace(
        app,
        config,
        bob.cookie,
        "Bob Docs",
      );

      const forbidden = multipartFilePayload("steal.docx", "PK alice only");
      const crossUser = await app.inject({
        method: "POST",
        url: `/api/workspaces/${bobWorkspaceId}/documents`,
        headers: {
          ...forbidden.headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: forbidden.payload,
      });
      assert.equal(crossUser.statusCode, 404, crossUser.body);
      assert.equal(crossUser.json().error.code, "WORKSPACE_NOT_FOUND");
      assert.equal(storage.objects.size, 0);

      const badType = multipartFilePayload("notes.txt", "plain text");
      const unsupported = await app.inject({
        method: "POST",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: {
          ...badType.headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: badType.payload,
      });
      assert.equal(unsupported.statusCode, 400, unsupported.body);
      assert.equal(unsupported.json().error.code, "UNSUPPORTED_FORMAT");

      const fileBytes = Buffer.from("PK fake-office-bytes");
      const good = multipartFilePayload("Q1 Report.docx", fileBytes);
      const upload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: {
          ...good.headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: good.payload,
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const body = upload.json() as {
        document: {
          id: string;
          workspaceId: string;
          name: string;
          format: string;
        };
        version: {
          id: string;
          documentId: string;
          versionNumber: number;
          storageKey: string;
          sizeBytes: number;
          source: string;
          createdByUserId: string;
        };
      };

      assert.equal(body.document.workspaceId, aliceWorkspaceId);
      assert.equal(body.document.name, "Q1 Report.docx");
      assert.equal(body.document.format, "docx");
      assert.equal(body.version.documentId, body.document.id);
      assert.equal(body.version.versionNumber, 1);
      assert.equal(body.version.source, "upload");
      assert.equal(body.version.createdByUserId, alice.userId);
      assert.equal(body.version.sizeBytes, fileBytes.byteLength);
      assert.equal(
        body.version.storageKey,
        `workspaces/${aliceWorkspaceId}/documents/${body.document.id}/versions/${body.version.id}/content.docx`,
      );
      assert.equal(storage.objects.has(body.version.storageKey), true);

      const docs = await dbClient.db
        .select({ id: schema.document.id })
        .from(schema.document)
        .where(
          and(
            eq(schema.document.workspaceId, aliceWorkspaceId),
            isNull(schema.document.deletedAt),
          ),
        );
      assert.equal(docs.length, 1);
      assert.equal(docs[0]?.id, body.document.id);

      const versions = await dbClient.db
        .select({
          versionNumber: schema.documentVersion.versionNumber,
          source: schema.documentVersion.source,
          createdByUserId: schema.documentVersion.createdByUserId,
          storageKey: schema.documentVersion.storageKey,
          parentVersionId: schema.documentVersion.parentVersionId,
        })
        .from(schema.documentVersion)
        .where(eq(schema.documentVersion.documentId, body.document.id));
      assert.equal(versions.length, 1);
      assert.equal(versions[0]?.versionNumber, 1);
      assert.equal(versions[0]?.source, "upload");
      assert.equal(versions[0]?.createdByUserId, alice.userId);
      assert.equal(versions[0]?.parentVersionId, null);
      assert.equal(versions[0]?.storageKey, body.version.storageKey);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "document list and latest-version download are owner-scoped",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const storage = createMemoryObjectStorage();
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage,
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "ListAlice",
      );
      const bob = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "ListBob",
      );
      const aliceWorkspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Alice List WS",
      );
      const bobWorkspaceId = await createWorkspace(
        app,
        config,
        bob.cookie,
        "Bob List WS",
      );

      const crossList = await app.inject({
        method: "GET",
        url: `/api/workspaces/${bobWorkspaceId}/documents`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(crossList.statusCode, 404, crossList.body);
      assert.equal(crossList.json().error.code, "WORKSPACE_NOT_FOUND");

      const v1Bytes = Buffer.from("PK version-one-bytes");
      const upload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: {
          ...multipartFilePayload("Report.docx", v1Bytes).headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: multipartFilePayload("Report.docx", v1Bytes).payload,
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const uploaded = upload.json() as {
        document: { id: string };
        version: { id: string; storageKey: string };
      };

      const deletedUpload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: {
          ...multipartFilePayload("Gone.docx", "PK gone").headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: multipartFilePayload("Gone.docx", "PK gone").payload,
      });
      assert.equal(deletedUpload.statusCode, 201, deletedUpload.body);
      const deletedDocId = (
        deletedUpload.json() as { document: { id: string } }
      ).document.id;
      await dbClient.db
        .update(schema.document)
        .set({ deletedAt: new Date() })
        .where(eq(schema.document.id, deletedDocId));

      const v2Bytes = Buffer.from("PK version-two-bytes-latest");
      const v2Id = randomUUID();
      const v2Key = `workspaces/${aliceWorkspaceId}/documents/${uploaded.document.id}/versions/${v2Id}/content.docx`;
      await storage.putObject({
        key: v2Key,
        body: v2Bytes,
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      await dbClient.db.insert(schema.documentVersion).values({
        id: v2Id,
        documentId: uploaded.document.id,
        versionNumber: 2,
        parentVersionId: uploaded.version.id,
        storageKey: v2Key,
        sizeBytes: v2Bytes.byteLength,
        sha256: null,
        source: "user",
        createdByUserId: alice.userId,
      });

      const list = await app.inject({
        method: "GET",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(list.statusCode, 200, list.body);
      const listed = list.json() as {
        documents: Array<{
          id: string;
          name: string;
          latestVersion: {
            id: string;
            versionNumber: number;
            sizeBytes: number;
            source: string;
          };
          storageKey?: string;
          latestVersionStorageKey?: string;
        }>;
      };
      assert.equal(listed.documents.length, 1);
      assert.equal(listed.documents[0]?.id, uploaded.document.id);
      assert.equal(listed.documents[0]?.latestVersion.versionNumber, 2);
      assert.equal(listed.documents[0]?.latestVersion.id, v2Id);
      assert.equal(listed.documents[0]?.latestVersion.source, "user");
      assert.equal(listed.documents[0]?.latestVersion.sizeBytes, v2Bytes.byteLength);
      assert.equal(
        JSON.stringify(listed).includes(v2Key) ||
          JSON.stringify(listed).includes("storageKey"),
        false,
      );

      const forbiddenDownload = await app.inject({
        method: "GET",
        url: `/api/documents/${uploaded.document.id}/download`,
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(forbiddenDownload.statusCode, 404, forbiddenDownload.body);
      assert.equal(forbiddenDownload.json().error.code, "DOCUMENT_NOT_FOUND");

      const missingDownload = await app.inject({
        method: "GET",
        url: `/api/documents/${randomUUID()}/download`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(missingDownload.statusCode, 404, missingDownload.body);

      const download = await app.inject({
        method: "GET",
        url: `/api/documents/${uploaded.document.id}/download`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(download.statusCode, 200, download.body);
      assert.equal(
        download.headers["content-type"],
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      assert.equal(
        download.headers["content-length"],
        String(v2Bytes.byteLength),
      );
      assert.match(
        String(download.headers["content-disposition"]),
        /attachment;.*filename="Report\.docx"/,
      );
      assert.deepEqual(download.rawPayload, v2Bytes);

      storage.objects.delete(v2Key);
      const missingObject = await app.inject({
        method: "GET",
        url: `/api/documents/${uploaded.document.id}/download`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(missingObject.statusCode, 500, missingObject.body);
      assert.equal(missingObject.json().error.code, "STORAGE_OBJECT_MISSING");
      assert.equal(
        String(missingObject.body).toLowerCase().includes("nosuchkey"),
        false,
      );
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "GET /api/documents/:documentId returns owned metadata with latest version only",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const storage = createMemoryObjectStorage();
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage,
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "DetailAlice",
      );
      const bob = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "DetailBob",
      );
      const aliceWorkspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Detail WS",
      );

      const upload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: {
          ...multipartFilePayload("Brief.docx", "PK v1").headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: multipartFilePayload("Brief.docx", "PK v1").payload,
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const uploaded = upload.json() as {
        document: { id: string; name: string };
        version: { id: string };
      };

      const v2Id = randomUUID();
      await dbClient.db.insert(schema.documentVersion).values({
        id: v2Id,
        documentId: uploaded.document.id,
        versionNumber: 2,
        parentVersionId: uploaded.version.id,
        storageKey: `workspaces/${aliceWorkspaceId}/documents/${uploaded.document.id}/versions/${v2Id}/content.docx`,
        sizeBytes: 42,
        sha256: null,
        source: "user",
        createdByUserId: alice.userId,
      });

      const detail = await app.inject({
        method: "GET",
        url: `/api/documents/${uploaded.document.id}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(detail.statusCode, 200, detail.body);
      const body = detail.json() as {
        document: {
          id: string;
          workspaceId: string;
          name: string;
          format: string;
          latestVersion: { id: string; versionNumber: number; sizeBytes: number };
        };
      };
      assert.equal(body.document.id, uploaded.document.id);
      assert.equal(body.document.workspaceId, aliceWorkspaceId);
      assert.equal(body.document.name, "Brief.docx");
      assert.equal(body.document.format, "docx");
      assert.equal(body.document.latestVersion.id, v2Id);
      assert.equal(body.document.latestVersion.versionNumber, 2);
      assert.equal(body.document.latestVersion.sizeBytes, 42);
      assert.equal(JSON.stringify(body).includes("storageKey"), false);

      const crossUser = await app.inject({
        method: "GET",
        url: `/api/documents/${uploaded.document.id}`,
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(crossUser.statusCode, 404, crossUser.body);
      assert.equal(crossUser.json().error.code, "DOCUMENT_NOT_FOUND");

      const missing = await app.inject({
        method: "GET",
        url: `/api/documents/${randomUUID()}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(missing.statusCode, 404, missing.body);

      await dbClient.db
        .update(schema.document)
        .set({ deletedAt: new Date() })
        .where(eq(schema.document.id, uploaded.document.id));
      const softDeletedDoc = await app.inject({
        method: "GET",
        url: `/api/documents/${uploaded.document.id}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(softDeletedDoc.statusCode, 404, softDeletedDoc.body);

      const otherUpload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${aliceWorkspaceId}/documents`,
        headers: {
          ...multipartFilePayload("Alive.docx", "PK alive").headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: multipartFilePayload("Alive.docx", "PK alive").payload,
      });
      assert.equal(otherUpload.statusCode, 201, otherUpload.body);
      const otherId = (otherUpload.json() as { document: { id: string } })
        .document.id;

      await dbClient.db
        .update(schema.workspace)
        .set({ deletedAt: new Date() })
        .where(eq(schema.workspace.id, aliceWorkspaceId));
      const softDeletedWs = await app.inject({
        method: "GET",
        url: `/api/documents/${otherId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(softDeletedWs.statusCode, 404, softDeletedWs.body);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "storage failure during upload creates no document rows",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const storage = createMemoryObjectStorage({ failPuts: true });
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage,
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "StorageFail",
      );
      const workspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Fail WS",
      );

      const before = await dbClient.db
        .select({ id: schema.document.id })
        .from(schema.document)
        .where(eq(schema.document.workspaceId, workspaceId));

      const file = multipartFilePayload("a.docx", "PK");
      const response = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/documents`,
        headers: {
          ...file.headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: file.payload,
      });
      assert.equal(response.statusCode, 500, response.body);

      const after = await dbClient.db
        .select({ id: schema.document.id })
        .from(schema.document)
        .where(eq(schema.document.workspaceId, workspaceId));
      assert.equal(after.length, before.length);
      assert.equal(storage.objects.size, 0);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "document recent/starred preferences are per-user and ownership-scoped",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage: createMemoryObjectStorage(),
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "PrefsAlice",
      );
      const bob = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "PrefsBob",
      );
      const workspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Prefs WS",
      );

      const file = multipartFilePayload("brief.docx", "PK");
      const upload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/documents`,
        headers: {
          ...file.headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: file.payload,
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const documentId = (
        upload.json() as { document: { id: string } }
      ).document.id;

      const get = await app.inject({
        method: "GET",
        url: `/api/documents/${documentId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(get.statusCode, 200, get.body);
      assert.equal(
        (get.json() as { document: { starred: boolean } }).document.starred,
        false,
      );

      const recent = await app.inject({
        method: "GET",
        url: "/api/documents/recent",
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(recent.statusCode, 200, recent.body);
      const recentDocs = (
        recent.json() as { documents: Array<{ id: string; lastOpenedAt: string }> }
      ).documents;
      assert.ok(recentDocs.some((doc) => doc.id === documentId));
      assert.ok(recentDocs.find((doc) => doc.id === documentId)?.lastOpenedAt);

      const star = await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/star`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { starred: true },
      });
      assert.equal(star.statusCode, 200, star.body);
      assert.equal(
        (star.json() as { starred: boolean }).starred,
        true,
      );

      const starred = await app.inject({
        method: "GET",
        url: "/api/documents/starred",
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(starred.statusCode, 200, starred.body);
      assert.ok(
        (
          starred.json() as { documents: Array<{ id: string }> }
        ).documents.some((doc) => doc.id === documentId),
      );

      const library = await app.inject({
        method: "GET",
        url: "/api/documents/library?format=docx",
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(library.statusCode, 200, library.body);
      assert.ok(
        (
          library.json() as { documents: Array<{ id: string; format: string }> }
        ).documents.some(
          (doc) => doc.id === documentId && doc.format === "docx",
        ),
      );

      const bobStar = await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/star`,
        headers: {
          "content-type": "application/json",
          cookie: bob.cookie,
          origin: config.webOrigin,
        },
        payload: { starred: true },
      });
      assert.equal(bobStar.statusCode, 404, bobStar.body);

      const bobRecent = await app.inject({
        method: "GET",
        url: "/api/documents/recent",
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(bobRecent.statusCode, 200, bobRecent.body);
      assert.equal(
        (
          bobRecent.json() as { documents: Array<{ id: string }> }
        ).documents.some((doc) => doc.id === documentId),
        false,
      );

      const unstar = await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/star`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { starred: false },
      });
      assert.equal(unstar.statusCode, 200, unstar.body);

      const starredAfter = await app.inject({
        method: "GET",
        url: "/api/documents/starred",
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(
        (
          starredAfter.json() as { documents: Array<{ id: string }> }
        ).documents.some((doc) => doc.id === documentId),
        false,
      );
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "document rename, soft-delete, restore, and trash filtering",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage: createMemoryObjectStorage(),
    });
    await app.ready();

    try {
      const alice = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "LifecycleAlice",
      );
      const bob = await signUpVerifyAndSignIn(
        app,
        config,
        emailSender,
        "LifecycleBob",
      );
      const workspaceId = await createWorkspace(
        app,
        config,
        alice.cookie,
        "Lifecycle WS",
      );

      const file = multipartFilePayload("notes.docx", "PK");
      const upload = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/documents`,
        headers: {
          ...file.headers,
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: file.payload,
      });
      assert.equal(upload.statusCode, 201, upload.body);
      const documentId = (
        upload.json() as { document: { id: string } }
      ).document.id;

      const rename = await app.inject({
        method: "PATCH",
        url: `/api/documents/${documentId}`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { name: "  Quarterly Notes  " },
      });
      assert.equal(rename.statusCode, 200, rename.body);
      assert.equal(
        (rename.json() as { document: { name: string } }).document.name,
        "Quarterly Notes.docx",
      );

      const badFormat = await app.inject({
        method: "PATCH",
        url: `/api/documents/${documentId}`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { name: "hack.pptx" },
      });
      assert.equal(badFormat.statusCode, 400, badFormat.body);

      const bobRename = await app.inject({
        method: "PATCH",
        url: `/api/documents/${documentId}`,
        headers: {
          "content-type": "application/json",
          cookie: bob.cookie,
          origin: config.webOrigin,
        },
        payload: { name: "Stolen.docx" },
      });
      assert.equal(bobRename.statusCode, 404, bobRename.body);

      await app.inject({
        method: "GET",
        url: `/api/documents/${documentId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      await app.inject({
        method: "PUT",
        url: `/api/documents/${documentId}/star`,
        headers: {
          "content-type": "application/json",
          cookie: alice.cookie,
          origin: config.webOrigin,
        },
        payload: { starred: true },
      });

      const del = await app.inject({
        method: "DELETE",
        url: `/api/documents/${documentId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(del.statusCode, 204, del.body);

      const getDeleted = await app.inject({
        method: "GET",
        url: `/api/documents/${documentId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(getDeleted.statusCode, 404, getDeleted.body);

      const list = await app.inject({
        method: "GET",
        url: `/api/workspaces/${workspaceId}/documents`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(
        (
          list.json() as { documents: Array<{ id: string }> }
        ).documents.some((doc) => doc.id === documentId),
        false,
      );

      for (const path of [
        "/api/documents/recent",
        "/api/documents/starred",
        "/api/documents/library?format=docx",
      ]) {
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: { cookie: alice.cookie, origin: config.webOrigin },
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.equal(
          (
            response.json() as { documents: Array<{ id: string }> }
          ).documents.some((doc) => doc.id === documentId),
          false,
          `${path} must hide trashed docs`,
        );
      }

      const trash = await app.inject({
        method: "GET",
        url: "/api/trash",
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(trash.statusCode, 200, trash.body);
      const trashBody = trash.json() as {
        documents: Array<{ id: string; name: string }>;
        workspaces: unknown[];
      };
      assert.ok(trashBody.documents.some((doc) => doc.id === documentId));

      const bobTrash = await app.inject({
        method: "GET",
        url: "/api/trash",
        headers: { cookie: bob.cookie, origin: config.webOrigin },
      });
      assert.equal(bobTrash.statusCode, 200, bobTrash.body);
      assert.equal(
        (
          bobTrash.json() as { documents: Array<{ id: string }> }
        ).documents.some((doc) => doc.id === documentId),
        false,
      );

      const restore = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/restore`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(restore.statusCode, 200, restore.body);
      assert.equal(
        (restore.json() as { document: { name: string } }).document.name,
        "Quarterly Notes.docx",
      );

      const getRestored = await app.inject({
        method: "GET",
        url: `/api/documents/${documentId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(getRestored.statusCode, 200, getRestored.body);

      // Trash workspace while document is active, then trash document, restore order.
      await app.inject({
        method: "DELETE",
        url: `/api/documents/${documentId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      const trashWs = await app.inject({
        method: "DELETE",
        url: `/api/workspaces/${workspaceId}`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(trashWs.statusCode, 204, trashWs.body);

      const restoreDocBlocked = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/restore`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(restoreDocBlocked.statusCode, 409, restoreDocBlocked.body);
      assert.equal(
        (restoreDocBlocked.json() as { error: { code: string } }).error.code,
        "WORKSPACE_DELETED",
      );

      const restoreWs = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/restore`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(restoreWs.statusCode, 200, restoreWs.body);

      const restoreDoc = await app.inject({
        method: "POST",
        url: `/api/documents/${documentId}/restore`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(restoreDoc.statusCode, 200, restoreDoc.body);

      const download = await app.inject({
        method: "GET",
        url: `/api/documents/${documentId}/download`,
        headers: { cookie: alice.cookie, origin: config.webOrigin },
      });
      assert.equal(download.statusCode, 200, download.body);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);
