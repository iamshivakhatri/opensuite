import assert from "node:assert/strict";
import { test } from "node:test";

import { createManagedTrialService } from "../managed-trial/service.js";
import { ManagedTrialError, type ManagedTrialAccount } from "../managed-trial/types.js";

function memoryRepository() {
  const accounts = new Map<string, ManagedTrialAccount>();
  const debits = new Set<string>();
  return {
    accounts,
    async get(userId: string) { return accounts.get(userId) ?? null; },
    async ensure(userId: string, grantMicros: number) {
      const current = accounts.get(userId);
      if (current) return current;
      const value = { userId, originalGrantMicros: grantMicros, balanceMicros: grantMicros, blockedAt: null };
      accounts.set(userId, value);
      return value;
    },
    async block(userId: string) {
      const value = accounts.get(userId);
      if (value) accounts.set(userId, { ...value, blockedAt: new Date().toISOString() });
    },
    async debit(input: { userId: string; modelUsageEventId: string; costMicros: number }) {
      const value = accounts.get(input.userId)!;
      if (debits.has(input.modelUsageEventId)) return value;
      debits.add(input.modelUsageEventId);
      const updated = { ...value, balanceMicros: value.balanceMicros - input.costMicros };
      accounts.set(input.userId, updated);
      return updated;
    },
  };
}

test("managed trial grants once, debits actual cost, and blocks the next call after overspend", async () => {
  const repository = memoryRepository();
  const trial = createManagedTrialService(repository, 500);
  await trial.beforeManagedCall("user-1");
  await trial.applyManagedUsage({ id: "usage-1", userId: "user-1", provider: "openrouter", model: "test", credentialSource: "managed", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: 700, costCurrency: "USD", costSource: "openrouter_usage_cost", agentRunId: null, createdAt: new Date().toISOString() });
  assert.equal((await trial.status("user-1")).balanceMicros, -200);
  await assert.rejects(() => trial.beforeManagedCall("user-1"), ManagedTrialError);
  await trial.applyManagedUsage({ id: "usage-1", userId: "user-1", provider: "openrouter", model: "test", credentialSource: "managed", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: 700, costCurrency: "USD", costSource: "openrouter_usage_cost", agentRunId: null, createdAt: new Date().toISOString() });
  assert.equal((await trial.status("user-1")).balanceMicros, -200);
});

test("missing managed cost blocks future managed calls without treating it as free", async () => {
  const trial = createManagedTrialService(memoryRepository(), 500);
  await trial.beforeManagedCall("user-2");
  await assert.rejects(
    () => trial.applyManagedUsage({ id: "usage-2", userId: "user-2", provider: "openrouter", model: "test", credentialSource: "managed", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: null, costCurrency: null, costSource: null, agentRunId: null, createdAt: new Date().toISOString() }),
    ManagedTrialError,
  );
  await assert.rejects(() => trial.beforeManagedCall("user-2"), ManagedTrialError);
});

test("BYOK usage never creates or debits a trial account", async () => {
  const repository = memoryRepository();
  const trial = createManagedTrialService(repository, 500);
  await trial.applyManagedUsage({ id: "usage-byok", userId: "user-3", provider: "openrouter", model: "test", credentialSource: "byok", inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null, costMicros: 400, costCurrency: "USD", costSource: "openrouter_usage_cost", agentRunId: null, createdAt: new Date().toISOString() });
  assert.equal(repository.accounts.size, 0);
});

test("managed trial status includes configurable display credits", async () => {
  const trial = createManagedTrialService(memoryRepository(), 500_000, 100);
  const status = await trial.status("user-credits");
  assert.equal(status.displayGrantCredits, 100);
  assert.equal(status.originalGrantMicros, 500_000);
  assert.equal(status.balanceMicros, 500_000);
});
