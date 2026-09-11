import type { AgentModel, ModelRequest, ModelResponse } from "@opensuite/agent-core";

import type { ModelUsageService } from "./service.js";
import type { ModelUsageAttribution } from "./types.js";

export interface MeteredAgentModelOptions {
  readonly attribution: Omit<ModelUsageAttribution, "agentRunId"> & {
    readonly agentRunId?: string | null;
  };
  readonly usage: ModelUsageService;
  /**
   * Persistence failures are logged via this hook and must not fail a
   * successful provider call. Matches telemetry isolation for model.turn.metrics.
   */
  readonly onRecordError?: (error: unknown) => void;
}

/**
 * One successful AgentModel.complete() → one usage event.
 * Records after the provider returns; never on thrown failures.
 */
export function createMeteredAgentModel(
  model: AgentModel,
  options: MeteredAgentModelOptions,
): AgentModel {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const response = await model.complete(request);
      try {
        await options.usage.recordFromProviderResponse({
          attribution: {
            userId: options.attribution.userId,
            provider: options.attribution.provider,
            model: options.attribution.model,
            credentialSource: options.attribution.credentialSource,
            agentRunId: options.attribution.agentRunId ?? null,
          },
          usage: response.meta?.usage,
          providerReportedCostUsd: response.meta?.providerReportedCostUsd,
        });
      } catch (error) {
        options.onRecordError?.(error);
      }
      return response;
    },
  };
}
