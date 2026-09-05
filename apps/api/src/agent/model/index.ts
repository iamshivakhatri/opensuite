import {
  AgentCoreError,
  createFakeAgentModel,
  type AgentModel,
  type ModelRequest,
} from "@opensuite/agent-core";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import type { AgentModelConfig, AppConfig } from "../../config/index.js";
import {
  createAnthropicAgentModel,
  type AnthropicMessagesClient,
} from "./anthropic.js";
import {
  createOpenAIAgentModel,
  type OpenAIResponsesClient,
} from "./openai.js";
import {
  createOpenRouterAgentModel,
  type OpenAIChatCompletionsClient,
} from "./openrouter.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Safe stub when no provider is configured. Routes never construct providers.
 */
export function createUnconfiguredAgentModel(): AgentModel {
  return {
    async complete() {
      throw new AgentCoreError(
        "MODEL_FAILURE",
        "Agent model provider is not configured",
        {
          diagnostic: {
            code: "MODEL_FAILURE",
            severity: "error",
            message: "Agent model provider is not configured",
          },
        },
      );
    },
  };
}

/**
 * Deterministic local model for development / manual UI testing.
 * Not available when NODE_ENV=production (rejected at config load).
 */
export function createDevelopmentFakeAgentModel(): AgentModel {
  return createFakeAgentModel({
    respond(request: ModelRequest) {
      const lastUser = [...request.messages]
        .reverse()
        .find((message) => message.role === "user");
      const instruction =
        lastUser && lastUser.role === "user"
          ? lastUser.content.trim()
          : "your request";
      return {
        content:
          `Understood. (fake model) I received: "${truncate(instruction, 240)}". ` +
          "No Office tools are connected yet, so I cannot inspect or edit document contents.",
        toolCalls: [],
      };
    },
  });
}

export interface CreateConfiguredAgentModelOptions {
  /** Inject a mock Anthropic client in tests. */
  readonly anthropicClient?: AnthropicMessagesClient;
  /** Inject a mock OpenAI Responses client in tests. */
  readonly openaiClient?: OpenAIResponsesClient;
  /** Inject a mock OpenAI Chat Completions client (OpenRouter) in tests. */
  readonly openrouterClient?: OpenAIChatCompletionsClient;
}

/**
 * Composition boundary for agent models. Routes/UI stay provider-agnostic.
 */
export function createConfiguredAgentModel(
  config: Pick<AppConfig, "agent" | "nodeEnv"> | AgentModelConfig,
  options: CreateConfiguredAgentModelOptions = {},
): AgentModel {
  const agent: AgentModelConfig =
    "agent" in config ? config.agent : (config as AgentModelConfig);

  switch (agent.provider) {
    case "unconfigured":
      return createUnconfiguredAgentModel();
    case "fake":
      return createDevelopmentFakeAgentModel();
    case "anthropic": {
      if (!agent.anthropicApiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY is required when AGENT_MODEL_PROVIDER=anthropic",
        );
      }
      const client =
        options.anthropicClient ??
        (new Anthropic({
          apiKey: agent.anthropicApiKey,
        }) as unknown as AnthropicMessagesClient);
      return createAnthropicAgentModel({
        client,
        model: agent.anthropicModel,
      });
    }
    case "openai": {
      if (!agent.openaiApiKey) {
        throw new Error(
          "OPENAI_API_KEY is required when AGENT_MODEL_PROVIDER=openai",
        );
      }
      const client =
        options.openaiClient ??
        (new OpenAI({
          apiKey: agent.openaiApiKey,
        }) as unknown as OpenAIResponsesClient);
      return createOpenAIAgentModel({
        client,
        model: agent.openaiModel,
      });
    }
    case "openrouter": {
      if (!agent.openrouterApiKey || !agent.openrouterModel) {
        throw new Error(
          "OPENROUTER_API_KEY and OPENROUTER_MODEL are required when AGENT_MODEL_PROVIDER=openrouter",
        );
      }
      const client =
        options.openrouterClient ??
        (new OpenAI({
          apiKey: agent.openrouterApiKey,
          baseURL: OPENROUTER_BASE_URL,
        }) as unknown as OpenAIChatCompletionsClient);
      return createOpenRouterAgentModel({
        client,
        model: agent.openrouterModel,
      });
    }
    default: {
      const _exhaustive: never = agent.provider;
      void _exhaustive;
      return createUnconfiguredAgentModel();
    }
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}
