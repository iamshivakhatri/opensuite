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
