import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient } from "@opensuite/db";
import * as schema from "@opensuite/db/schema";
import { eq } from "drizzle-orm";

import { createAuth } from "../auth/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import { createMemoryObjectStorage } from "../storage/index.js";
import {
  createStubEmailSender,
  extractEmailActionUrl,
} from "./support/stub-email-sender.js";
import { testAgentEnv, testS3Env } from "./support/test-env.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

function productionSameSiteConfig() {
  return loadConfig({
    NODE_ENV: "production",
    LOG_LEVEL: "silent",
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ??
      "test-secret-that-is-at-least-32-characters-long",
    BETTER_AUTH_URL: "https://api.opensuite.test",
    WEB_ORIGIN: "https://www.opensuite.test",
    AUTH_CROSS_ORIGIN: "false",
    RESEND_API_KEY: "re_test_key_unused_stub_sender_is_injected_instead",
    EMAIL_FROM: "OpenSuite <noreply@example.com>",
    ...testAgentEnv,
    ...testS3Env,
  });
}

function testConfig(overrides: Record<string, string | undefined> = {}) {
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
    ...testAgentEnv,
    ...testS3Env,
    ...overrides,
  });
}

type GoogleProfile = {
  readonly email: string;
  readonly sub: string;
  readonly email_verified: boolean;
  readonly name?: string;
};

function googleIdToken(profile: GoogleProfile) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(profile)).toString("base64url");
  return `${header}.${payload}.test-signature`;
}

function cookieHeader(setCookie: string | string[] | undefined) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

async function runGoogleCallback(
  app: Awaited<ReturnType<typeof buildApp>>,
  config: ReturnType<typeof testConfig>,
  profile: GoogleProfile,
  errorCallbackURL?: string,
) {
  const started = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/social",
    headers: { "content-type": "application/json", origin: config.webOrigin },
    payload: {
      provider: "google",
      callbackURL: `${config.webOrigin}/app`,
      errorCallbackURL,
      disableRedirect: true,
    },
  });
  assert.equal(started.statusCode, 200, started.body);
  const authorizationUrl = new URL((started.json() as { url: string }).url);
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          token_type: "Bearer",
          id_token: googleIdToken(profile),
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  try {
    return await app.inject({
      method: "GET",
      url: `/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`,
      headers: {
        cookie: cookieHeader(started.headers["set-cookie"]),
        origin: config.webOrigin,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test(
  "sign-up creates an unverified user that cannot sign in until the verification link is used",
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

    const email = `auth-test-${randomUUID()}@example.com`;
    const password = "password1234";

    try {
      // 1. Sign up: user is created but not signed in (no session cookie),
      // and a verification email is sent.
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: {
          name: "Auth Test User",
          email,
          password,
          callbackURL: `${config.webOrigin}/sign-in?verified=true`,
        },
      });

      assert.equal(signUp.statusCode, 200, signUp.body);
      const signUpBody = signUp.json() as {
        token: string | null;
        user: { email?: string; emailVerified?: boolean };
      };
      assert.equal(signUpBody.token, null);
      assert.equal(signUpBody.user.email, email);
      assert.equal(signUpBody.user.emailVerified, false);
      assert.equal(signUp.headers["set-cookie"], undefined);

      assert.equal(emailSender.sent.length, 1);
      const verificationEmail = emailSender.sent[0];
      assert.ok(verificationEmail);
      assert.equal(verificationEmail.to, email);
      assert.match(verificationEmail.subject, /verify/i);
      const verificationUrl = extractEmailActionUrl(verificationEmail);
      assert.match(verificationUrl, /\/api\/auth\/verify-email\?token=/);

      // 2. Signing in before verifying must fail with EMAIL_NOT_VERIFIED.
      const unverifiedSignIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: { email, password },
      });

      assert.equal(unverifiedSignIn.statusCode, 403, unverifiedSignIn.body);
      const unverifiedBody = unverifiedSignIn.json() as { code?: string };
      assert.equal(unverifiedBody.code, "EMAIL_NOT_VERIFIED");

      // 3. Follow the emailed verification link.
      const verifyUrl = new URL(verificationUrl);
      const verify = await app.inject({
        method: "GET",
        url: `${verifyUrl.pathname}${verifyUrl.search}`,
        headers: { origin: config.webOrigin },
      });

      assert.equal(verify.statusCode, 302, verify.body);
      assert.equal(
        verify.headers.location,
        `${config.webOrigin}/sign-in?verified=true`,
      );

      // 4. Signing in after verification succeeds.
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
      assert.ok(setCookie, "expected session cookie after verified sign-in");
      const cookieHeader = Array.isArray(setCookie)
        ? setCookie.join("; ")
        : setCookie;

      // 5. The session works against our protected route.
      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieHeader, origin: config.webOrigin },
      });

      assert.equal(me.statusCode, 200, me.body);
      const meBody = me.json() as {
        user?: { id?: string; name?: string; email?: string };
      };
      assert.equal(meBody.user?.email, email);
      assert.equal(meBody.user?.name, "Auth Test User");
      assert.ok(meBody.user?.id);

      const meWithoutSession = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { origin: config.webOrigin },
      });

      assert.equal(meWithoutSession.statusCode, 401, meWithoutSession.body);

      const meWithInvalidCookie = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: {
          cookie: "better-auth.session_token=not-a-real-session-token",
          origin: config.webOrigin,
        },
      });

      assert.equal(meWithInvalidCookie.statusCode, 401, meWithInvalidCookie.body);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "password reset invalidates the old password and accepts the new one",
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

    const email = `reset-test-${randomUUID()}@example.com`;
    const oldPassword = "old-password-1234";
    const newPassword = "new-password-5678";

    try {
      // Create + verify a user (same path as the sign-up test).
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: {
          name: "Reset Test User",
          email,
          password: oldPassword,
          callbackURL: `${config.webOrigin}/sign-in?verified=true`,
        },
      });
      assert.equal(signUp.statusCode, 200, signUp.body);

      const verificationUrl = extractEmailActionUrl(emailSender.sent[0]!);
      const verifyUrl = new URL(verificationUrl);
      const verify = await app.inject({
        method: "GET",
        url: `${verifyUrl.pathname}${verifyUrl.search}`,
        headers: { origin: config.webOrigin },
      });
      assert.equal(verify.statusCode, 302, verify.body);

      // Request a password reset — always returns the same generic success,
      // whether or not the email exists (enumeration protection).
      const unknownEmailReset = await app.inject({
        method: "POST",
        url: "/api/auth/request-password-reset",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: {
          email: `no-such-user-${randomUUID()}@example.com`,
          redirectTo: `${config.webOrigin}/reset-password`,
        },
      });
      assert.equal(unknownEmailReset.statusCode, 200, unknownEmailReset.body);
      const unknownBody = unknownEmailReset.json() as {
        status?: boolean;
        message?: string;
      };
      assert.equal(unknownBody.status, true);

      const emailsBeforeReset = emailSender.sent.length;

      const requestReset = await app.inject({
        method: "POST",
        url: "/api/auth/request-password-reset",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: {
          email,
          redirectTo: `${config.webOrigin}/reset-password`,
        },
      });
      assert.equal(requestReset.statusCode, 200, requestReset.body);
      const requestBody = requestReset.json() as {
        status?: boolean;
        message?: string;
      };
      assert.equal(requestBody.status, true);
      // Same generic message as the unknown-email case.
      assert.equal(requestBody.message, unknownBody.message);

      assert.equal(emailSender.sent.length, emailsBeforeReset + 1);
      const resetEmail = emailSender.sent[emailSender.sent.length - 1]!;
      assert.equal(resetEmail.to, email);
      assert.match(resetEmail.subject, /reset/i);
      const resetCallbackUrl = extractEmailActionUrl(resetEmail);
      assert.match(resetCallbackUrl, /\/api\/auth\/reset-password\//);

      // Click the emailed link → redirect to frontend with ?token=.
      const resetCallback = new URL(resetCallbackUrl);
      const callback = await app.inject({
        method: "GET",
        url: `${resetCallback.pathname}${resetCallback.search}`,
        headers: { origin: config.webOrigin },
      });
      assert.equal(callback.statusCode, 302, callback.body);
      const location = callback.headers.location;
      assert.ok(typeof location === "string");
      const redirect = new URL(location);
      assert.equal(redirect.origin + redirect.pathname, `${config.webOrigin}/reset-password`);
      const token = redirect.searchParams.get("token");
      assert.ok(token, "expected reset token in redirect");

      // Submit the new password.
      const reset = await app.inject({
        method: "POST",
        url: "/api/auth/reset-password",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: { newPassword, token },
      });
      assert.equal(reset.statusCode, 200, reset.body);

      // Old password no longer works.
      const oldSignIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: { email, password: oldPassword },
      });
      assert.equal(oldSignIn.statusCode, 401, oldSignIn.body);

      // New password works; /api/me works; sign-out works.
      const newSignIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: {
          "content-type": "application/json",
          origin: config.webOrigin,
        },
        payload: { email, password: newPassword },
      });
      assert.equal(newSignIn.statusCode, 200, newSignIn.body);
      const setCookie = newSignIn.headers["set-cookie"];
      assert.ok(setCookie);
      const cookieHeader = Array.isArray(setCookie)
        ? setCookie.join("; ")
        : setCookie;

      const me = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieHeader, origin: config.webOrigin },
      });
      assert.equal(me.statusCode, 200, me.body);
      assert.equal((me.json() as { user: { email: string } }).user.email, email);

      const signOut = await app.inject({
        method: "POST",
        url: "/api/auth/sign-out",
        headers: { cookie: cookieHeader, origin: config.webOrigin },
      });
      assert.equal(signOut.statusCode, 200, signOut.body);

      const meAfterSignOut = await app.inject({
        method: "GET",
        url: "/api/me",
        headers: { cookie: cookieHeader, origin: config.webOrigin },
      });
      assert.equal(meAfterSignOut.statusCode, 401, meAfterSignOut.body);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "Google OAuth creates, links, returns, and safely rejects account states",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig({
      GOOGLE_CLIENT_ID: "google-test-client-id",
      GOOGLE_CLIENT_SECRET: "google-test-client-secret",
    });
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage: createMemoryObjectStorage(),
    });
    const newEmail = `new-google-${randomUUID()}@example.com`;
    const existingEmail = `existing-google-${randomUUID()}@example.com`;
    const unverifiedEmail = `unverified-google-${randomUUID()}@example.com`;

    try {
      const newGoogle = await runGoogleCallback(app, config, {
        email: newEmail.toUpperCase(),
        sub: `google-${randomUUID()}`,
        email_verified: true,
        name: "New Google User",
      });
      assert.equal(newGoogle.statusCode, 302, newGoogle.body);
      assert.equal(newGoogle.headers.location, `${config.webOrigin}/app`);
      assert.match(cookieHeader(newGoogle.headers["set-cookie"]), /session_token=/);

      const [newUser] = await dbClient.db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, newEmail));
      assert.ok(newUser);
      assert.equal(newUser.emailVerified, true);
      const newAccounts = await dbClient.db
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, newUser.id));
      assert.equal(newAccounts.length, 1);
      assert.equal(newAccounts[0]?.providerId, "google");

      const existingPassword = "password1234";
      const existingSignUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: {
          name: "Existing Password User",
          email: existingEmail,
          password: existingPassword,
          callbackURL: `${config.webOrigin}/sign-in`,
        },
      });
      assert.equal(existingSignUp.statusCode, 200, existingSignUp.body);
      const verificationUrl = new URL(extractEmailActionUrl(emailSender.sent.at(-1)!));
      const verified = await app.inject({
        method: "GET",
        url: `${verificationUrl.pathname}${verificationUrl.search}`,
        headers: { origin: config.webOrigin },
      });
      assert.equal(verified.statusCode, 302, verified.body);

      const existingGoogle = {
        email: existingEmail.toUpperCase(),
        sub: `google-${randomUUID()}`,
        email_verified: true,
      };
      const linked = await runGoogleCallback(app, config, existingGoogle);
      assert.equal(linked.statusCode, 302, linked.body);
      assert.equal(linked.headers.location, `${config.webOrigin}/app`);
      const [linkedUser] = await dbClient.db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, existingEmail));
      assert.ok(linkedUser);
      const linkedAccounts = await dbClient.db
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, linkedUser.id));
      assert.equal(linkedAccounts.filter((account) => account.providerId === "google").length, 1);

      const returning = await runGoogleCallback(app, config, existingGoogle);
      assert.equal(returning.statusCode, 302, returning.body);
      assert.equal(returning.headers.location, `${config.webOrigin}/app`);
      const usersWithExistingEmail = await dbClient.db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, existingEmail));
      assert.equal(usersWithExistingEmail.length, 1);

      const unverifiedSignUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: {
          name: "Unverified Password User",
          email: unverifiedEmail,
          password: "password1234",
          callbackURL: `${config.webOrigin}/sign-in`,
        },
      });
      assert.equal(unverifiedSignUp.statusCode, 200, unverifiedSignUp.body);

      const rejected = await runGoogleCallback(
        app,
        config,
        {
          email: unverifiedEmail.toUpperCase(),
          sub: `google-${randomUUID()}`,
          email_verified: true,
        },
        `${config.webOrigin}/sign-in`,
      );
      assert.equal(rejected.statusCode, 302, rejected.body);
      assert.equal(
        rejected.headers.location,
        `${config.webOrigin}/sign-in?error=account_not_linked`,
      );
      const [unverifiedUser] = await dbClient.db
        .select()
        .from(schema.user)
        .where(eq(schema.user.email, unverifiedEmail));
      assert.ok(unverifiedUser);
      const unverifiedAccounts = await dbClient.db
        .select()
        .from(schema.account)
        .where(eq(schema.account.userId, unverifiedUser.id));
      assert.equal(unverifiedAccounts.some((account) => account.providerId === "google"), false);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);

test(
  "production same-site sessions use Secure, HttpOnly, SameSite=Lax cookies",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = productionSameSiteConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const app = await buildApp(config, {
      auth,
      db: dbClient.db,
      storage: createMemoryObjectStorage(),
    });
    const email = `cookie-test-${randomUUID()}@example.com`;
    const password = "password1234";

    try {
      const signUp = await app.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: {
          name: "Cookie Test User",
          email,
          password,
          callbackURL: `${config.webOrigin}/sign-in`,
        },
      });
      assert.equal(signUp.statusCode, 200, signUp.body);

      const verificationUrl = extractEmailActionUrl(emailSender.sent[0]!);
      const verify = new URL(verificationUrl);
      const verified = await app.inject({
        method: "GET",
        url: `${verify.pathname}${verify.search}`,
        headers: { origin: config.webOrigin },
      });
      assert.equal(verified.statusCode, 302, verified.body);

      const signIn = await app.inject({
        method: "POST",
        url: "/api/auth/sign-in/email",
        headers: { "content-type": "application/json", origin: config.webOrigin },
        payload: { email, password },
      });
      assert.equal(signIn.statusCode, 200, signIn.body);
      const cookie = Array.isArray(signIn.headers["set-cookie"])
        ? signIn.headers["set-cookie"].join("; ")
        : signIn.headers["set-cookie"];
      assert.ok(cookie);
      assert.match(cookie, /; Secure/i);
      assert.match(cookie, /; HttpOnly/i);
      assert.match(cookie, /; SameSite=Lax/i);
    } finally {
      await app.close();
      await dbClient.close();
    }
  },
);
