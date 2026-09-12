import { OPENROUTER_USAGE_COST_SOURCE } from "../openrouter-models/cost.js";
import type { ModelUsageEvent } from "../model-usage/types.js";
import type { ManagedTrialRepository } from "./repository.js";
import { ManagedTrialError, type ManagedTrialAccount } from "./types.js";

export function createManagedTrialService(repository: ManagedTrialRepository, grantMicros: number) {
  async function ensure(userId: string): Promise<ManagedTrialAccount> {
    if (grantMicros <= 0) throw new ManagedTrialError("MANAGED_TRIAL_DISABLED", "Managed AI trial is not available.");
    return repository.ensure(userId, grantMicros);
  }
  return {
    async beforeManagedCall(userId: string): Promise<void> {
      const value = await ensure(userId);
      if (value.blockedAt || value.balanceMicros <= 0) throw new ManagedTrialError(value.blockedAt ? "MANAGED_TRIAL_ACCOUNTING_FAILED" : "MANAGED_TRIAL_EXHAUSTED", "Managed AI trial is unavailable.");
    },
    async applyManagedUsage(event: ModelUsageEvent): Promise<void> {
      if (event.credentialSource !== "managed") return;
      if (event.costMicros === null || event.costSource !== OPENROUTER_USAGE_COST_SOURCE) {
        await ensure(event.userId);
        await repository.block(event.userId);
        throw new ManagedTrialError("MANAGED_TRIAL_ACCOUNTING_FAILED", "Managed AI accounting is unavailable.");
      }
      await repository.debit({ userId: event.userId, modelUsageEventId: event.id, costMicros: event.costMicros });
    },
    async block(userId: string): Promise<void> {
      await ensure(userId);
      await repository.block(userId);
    },
    async status(userId: string) {
      const value = await repository.get(userId);
      const balanceMicros = value?.balanceMicros ?? grantMicros;
      return { enabled: grantMicros > 0, originalGrantMicros: value?.originalGrantMicros ?? grantMicros, balanceMicros, exhausted: grantMicros <= 0 || Boolean(value?.blockedAt) || balanceMicros <= 0 };
    },
  };
}
export type ManagedTrialService = ReturnType<typeof createManagedTrialService>;
