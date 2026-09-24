import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alphaUserRateLimits,
  createUserRateLimiter,
  type UserRateLimitPolicy,
} from "../user-rate-limit.js";

test("agent runs are limited per user and recover after an hour", () => {
  let currentTime = 0;
  const limiter = createUserRateLimiter(alphaUserRateLimits, () => currentTime);

  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(limiter.consume("user-a", "agentRun").allowed, true);
  }
  assert.equal(limiter.consume("user-a", "agentRun").allowed, false);
  assert.equal(limiter.consume("user-b", "agentRun").allowed, true);

  currentTime += 60 * 60 * 1000;
  assert.equal(limiter.consume("user-a", "agentRun").allowed, true);
});

test("document uploads and workspace creation enforce their alpha limits", () => {
  let currentTime = 0;
  const limiter = createUserRateLimiter(alphaUserRateLimits, () => currentTime);

  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(limiter.consume("user-a", "documentWrite").allowed, true);
  }
  assert.equal(limiter.consume("user-a", "documentWrite").allowed, false);
  currentTime += 60 * 60 * 1000;
  assert.equal(limiter.consume("user-a", "documentWrite").allowed, true);

  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal(limiter.consume("user-a", "workspaceCreate").allowed, true);
  }
  assert.equal(limiter.consume("user-a", "workspaceCreate").allowed, false);
  currentTime += 24 * 60 * 60 * 1000;
  assert.equal(limiter.consume("user-a", "workspaceCreate").allowed, true);
});

test("a rejected limit includes a useful retry time", () => {
  let currentTime = 1_000;
  const policy: UserRateLimitPolicy = {
    agentRun: [{ limit: 1, windowMs: 5_000 }],
    documentWrite: [{ limit: 1, windowMs: 5_000 }],
    workspaceCreate: [{ limit: 1, windowMs: 5_000 }],
  };
  const limiter = createUserRateLimiter(policy, () => currentTime);

  limiter.consume("user-a", "agentRun");
  const result = limiter.consume("user-a", "agentRun");
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 5);

  currentTime += 5_000;
  assert.equal(limiter.consume("user-a", "agentRun").allowed, true);
});
