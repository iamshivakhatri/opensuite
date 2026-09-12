import type { AgentModel, ModelRequest, ModelResponse } from "@opensuite/agent-core";

import type { ModelUsageService } from "./service.js";
import type { ModelUsageAttribution } from "./types.js";
import type { ModelUsageEvent } from "./types.js";

export interface MeteredAgentModelOptions {
  readonly attribution: Omit<ModelUsageAttribution, "agentRunId"> & {
    readonly agentRunId?: string | null;
  };
  readonly usage: ModelUsageService;
  /**
   * Persistence failures are logged via this hook and must not fail a
   * successful provider call. Matches telemetry isolation for model.turn.metrics.
   */
  readonly onRecordError?: (error: unknown) => unknown | Promise<unknown>;
  readonly beforeComplete?: () => Promise<void>;
  readonly afterRecord?: (event: ModelUsageEvent) => Promise<void>;
  /** Managed accounting must stop the run when durable accounting fails. */
  readonly failClosed?: boolean;
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
      await options.beforeComplete?.();
      const response = await model.complete(request);
      try {
        const event = await options.usage.recordFromProviderResponse({
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
        await options.afterRecord?.(event);
      } catch (error) {
        await options.onRecordError?.(error);
        if (options.failClosed) throw error;
      }
      return response;
    },
  };
}
