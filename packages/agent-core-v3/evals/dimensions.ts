/**
 * Future agent-behavior evaluation dimensions.
 *
 * RUNTIME EVALS (`evals/scenarios.ts`, `pnpm agent:v3:eval`) prove deterministic
 * loop mechanics with a fake model. They are not measures of model judgment.
 *
 * AGENT EVALS (manual now; scripted later) measure model behavior across
 * representative tasks. Do not mix the two.
 *
 * Score each agent-eval run against these dimensions when reviewing traces:
 * - task_completion
 * - unnecessary_reads
 * - repeated_equivalent_reads
 * - unnecessary_model_turns
 * - unnecessary_tool_calls
 * - mutation_success_or_failure
 * - correct_tool_failure_handling
 * - finish_usage
 * - unsupported_capability_honesty
 * - unrelated_modifications
 * - token_usage
 * - latency
 */

export const AGENT_BEHAVIOR_DIMENSIONS = [
  "task_completion",
  "unnecessary_reads",
  "repeated_equivalent_reads",
  "unnecessary_model_turns",
  "unnecessary_tool_calls",
  "mutation_success_or_failure",
  "correct_tool_failure_handling",
  "finish_usage",
  "unsupported_capability_honesty",
  "unrelated_modifications",
  "token_usage",
  "latency",
] as const;

export type AgentBehaviorDimension =
  (typeof AGENT_BEHAVIOR_DIMENSIONS)[number];

/** Optional sparse notes for a manual/scripted agent-eval review. */
export type AgentBehaviorReview = {
  readonly scenarioId: string;
  readonly notes?: Partial<Record<AgentBehaviorDimension, string>>;
};
