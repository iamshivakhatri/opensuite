import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient } from "@opensuite/db";

import { createAuth } from "../auth/index.js";
import { buildApp } from "../app.js";
import { loadConfig } from "../config/index.js";
import {
  createStubEmailSender,
  extractEmailActionUrl,
} from "./support/stub-email-sender.js";

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
  });
}

test(
  "sign-up creates an unverified user that cannot sign in until the verification link is used",
  { skip: !runDbIntegrationTests || databaseUrl === undefined },
  async () => {
    const config = testConfig();
    const dbClient = createDbClient({ databaseUrl: config.databaseUrl });
    const emailSender = createStubEmailSender();
    const auth = createAuth(config, dbClient.db, emailSender);
    const app = await buildApp(config, { auth, db: dbClient.db });
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
    const app = await buildApp(config, { auth, db: dbClient.db });
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
