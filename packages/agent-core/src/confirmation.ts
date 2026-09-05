/**
 * Replaceable confirmation boundary for destructive tools.
 * Application orchestration may later back this with durable
 * waiting_for_confirmation + user UI — AgentRunner only needs approve/deny.
 *
 * Production-safe default when no gate is injected: deny destructive tools.
 * Opt in to auto-approve only in tests / trusted local runs.
 */

export interface ConfirmationRequest {
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly reason: string;
}

export interface ConfirmationGate {
  /**
   * @returns true to execute the tool; false to skip with CONFIRMATION_DENIED.
   */
  confirm(
    request: ConfirmationRequest,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

/** Immediate approve — opt-in for tests / trusted local deterministic runs. */
export class AutoApproveConfirmationGate implements ConfirmationGate {
  async confirm(): Promise<boolean> {
    return true;
  }
}

export const autoApproveConfirmationGate: ConfirmationGate =
  new AutoApproveConfirmationGate();

/** Immediate deny — default when no gate is provided; also useful for tests. */
export const denyAllConfirmationGate: ConfirmationGate = {
  async confirm() {
    return false;
  },
};

export function createScriptedConfirmationGate(
  answers: readonly boolean[],
): ConfirmationGate {
  let index = 0;
  return {
    async confirm() {
      const answer = answers[index] ?? false;
      index += 1;
      return answer;
    },
  };
}
