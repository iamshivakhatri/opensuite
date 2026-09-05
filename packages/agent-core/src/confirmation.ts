/**
 * Replaceable confirmation boundary for destructive tools.
 * Application orchestration may later back this with durable
 * waiting_for_confirmation + user UI — AgentRunner only needs approve/deny.
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

/** Immediate approve — default when no gate is provided (tests / trusted envs). */
export const autoApproveConfirmationGate: ConfirmationGate = {
  async confirm() {
    return true;
  },
};

/** Immediate deny — useful for tests. */
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
