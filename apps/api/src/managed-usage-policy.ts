import type { ModelUsageEvent } from "./model-usage/types.js";

export interface ManagedUsageStatus {
  readonly enabled: boolean;
  readonly originalGrantMicros: number;
  readonly balanceMicros: number;
  readonly displayGrantCredits: number;
  readonly exhausted: boolean;
}

/** Server-paid model allowance. BYOK calls never reach this policy. */
export interface ManagedUsagePolicy {
  beforeManagedCall(userId: string): Promise<void>;
  afterUsageRecorded(event: ModelUsageEvent): Promise<void>;
  status(userId: string): Promise<ManagedUsageStatus>;
}
