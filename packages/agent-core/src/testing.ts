import { AgentCoreError } from "./errors.js";
import { noopEventSink } from "./events.js";
import type {
  AgentModel,
  AgentTool,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolInputSchema,
  ToolRisk,
} from "./model.js";
import type {
  DocumentOperation,
  DocumentRuntime,
  DocumentRuntimeOptions,
  InspectionResult,
  OperationResult,
} from "./runtime.js";
import { unsupportedCapabilityOperation } from "./runtime.js";
import {
  Capabilities,
  createCapabilities,
  type DocumentRef,
  type RuntimeCapabilities,
} from "./types.js";

/**
 * Test doubles for contract tests and AgentRunner unit tests.
 * Not production implementations.
 */

export function createFakeTool<TInput, TResult>(options: {
  name: string;
  description?: string;
  risk?: ToolRisk;
  executionMode?: ToolExecutionMode;
  inputSchema?: ToolInputSchema;
  parseInput?: (raw: unknown) => TInput;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TResult>;
}): AgentTool<TInput, TResult> {
  return {
    name: options.name,
    description: options.description ?? options.name,
    risk: options.risk ?? "safe",
    executionMode: options.executionMode,
    inputSchema: options.inputSchema ?? { type: "object" },
    parseInput: options.parseInput ?? ((raw: unknown) => raw as TInput),
    execute: options.execute,
  };
}

export function createFakeToolExecutionContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    runId: overrides.runId ?? "run-test",
    primaryDocument: overrides.primaryDocument ?? null,
    signal: overrides.signal ?? new AbortController().signal,
    events: overrides.events ?? noopEventSink,
    runtime: overrides.runtime,
  };
}

export interface FakeAgentModelOptions {
  /** Fixed response, or a function of the request. */
  readonly respond:
    | ModelResponse
    | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>);
}

export function createFakeAgentModel(
  options: FakeAgentModelOptions,
): AgentModel {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.signal?.aborted) {
        throw new AgentCoreError("CANCELLED", "Model call aborted", {
          diagnostic: {
            code: "CANCELLED",
            severity: "error",
            message: "Model call aborted",
          },
        });
      }
      const response =
        typeof options.respond === "function"
          ? await options.respond(request)
          : options.respond;
      return {
        content: response.content,
        toolCalls: response.toolCalls ?? [],
      };
    },
  };
}

/**
 * Deterministic multi-turn fake: each complete() consumes the next scripted step.
 */
export function createScriptedAgentModel(
  steps: ReadonlyArray<
    | ModelResponse
    | ((request: ModelRequest) => ModelResponse | Promise<ModelResponse>)
  >,
): AgentModel {
  let index = 0;
  return createFakeAgentModel({
    async respond(request) {
      if (index >= steps.length) {
        throw new AgentCoreError(
          "MODEL_FAILURE",
          "Scripted model has no more responses",
        );
      }
      const step = steps[index]!;
      index += 1;
      return typeof step === "function" ? step(request) : step;
    },
  });
}

export function assistantOnlyResponse(content: string): ModelResponse {
  return { content, toolCalls: [] };
}

export function toolCallResponse(
  content: string,
  toolCalls: readonly ModelToolCall[],
): ModelResponse {
  return { content, toolCalls };
}

export interface FakeDocumentRuntimeOptions {
  readonly capabilities?: RuntimeCapabilities;
  readonly inspect?: (
    document: DocumentRef,
    options?: DocumentRuntimeOptions,
  ) => Promise<InspectionResult>;
  readonly execute?: (
    document: DocumentRef,
    operation: DocumentOperation,
    options?: DocumentRuntimeOptions,
  ) => Promise<OperationResult>;
}

export function createFakeDocumentRuntime(
  options: FakeDocumentRuntimeOptions = {},
): DocumentRuntime {
  const capabilities =
    options.capabilities ?? createCapabilities(Capabilities.DocumentInspect);

  return {
    capabilities() {
      return capabilities;
    },
    async inspect(document, runtimeOptions) {
      if (runtimeOptions?.signal?.aborted) {
        throw new AgentCoreError("CANCELLED", "Inspect aborted");
      }
      if (options.inspect) {
        return options.inspect(document, runtimeOptions);
      }
      const unitKind =
        document.format === "pptx"
          ? "slide"
          : document.format === "xlsx"
            ? "sheet"
            : "page";
      return {
        status: "success",
        format: document.format,
        capabilities,
        diagnostics: [],
        payload: {
          format: document.format,
          summary: {
            title: null,
            unitKind,
            unitCount: 1,
          },
        },
      };
    },
    async execute(document, operation, runtimeOptions) {
      if (runtimeOptions?.signal?.aborted) {
        throw new AgentCoreError("CANCELLED", "Execute aborted");
      }
      if (options.execute) {
        return options.execute(document, operation, runtimeOptions);
      }
      return unsupportedCapabilityOperation(Capabilities.DocumentMutate);
    },
  };
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AgentCoreError("CANCELLED", "Delay aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AgentCoreError("CANCELLED", "Delay aborted"));
      },
      { once: true },
    );
  });
}
