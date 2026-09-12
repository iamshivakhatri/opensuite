export interface ManagedTrialAccount {
  readonly userId: string;
  readonly originalGrantMicros: number;
  readonly balanceMicros: number;
  readonly blockedAt: string | null;
}

export class ManagedTrialError extends Error {
  constructor(
    readonly code: "MANAGED_TRIAL_DISABLED" | "MANAGED_TRIAL_EXHAUSTED" | "MANAGED_TRIAL_ACCOUNTING_FAILED",
    message: string,
  ) {
    super(message);
  }
}
