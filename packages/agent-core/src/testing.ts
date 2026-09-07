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
  DocumentFindQuery,
  DocumentInspectOptions,
  DocumentOperation,
  DocumentRuntime,
  DocumentRuntimeOptions,
  FindResult,
  InspectionResult,
  OperationResult,
} from "./runtime.js";
import {
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
} from "./runtime.js";
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
  effect?: import("./model.js").ToolEffect;
  executionMode?: ToolExecutionMode;
  inputSchema?: ToolInputSchema;
  parseInput?: (raw: unknown) => TInput;
  execute: (input: TInput, ctx: ToolExecutionContext) => Promise<TResult>;
}): AgentTool<TInput, TResult> {
  return {
    name: options.name,
    description: options.description ?? options.name,
    risk: options.risk ?? "safe",
    effect: options.effect,
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
    mutations: overrides.mutations,
    advancePrimaryDocument: overrides.advancePrimaryDocument,
    handles: overrides.handles,
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
      if (request.onTextDelta && response.content) {
        // Deterministic small chunks for tests / fake provider.
        const chunkSize = 12;
        for (let i = 0; i < response.content.length; i += chunkSize) {
          await request.onTextDelta(response.content.slice(i, i + chunkSize));
        }
      }
      return {
        content: response.content,
        toolCalls: response.toolCalls ?? [],
        ...(response.meta !== undefined ? { meta: response.meta } : {}),
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
    options?: DocumentInspectOptions,
  ) => Promise<InspectionResult>;
  readonly find?: (
    document: DocumentRef,
    query: DocumentFindQuery,
    options?: DocumentRuntimeOptions,
  ) => Promise<FindResult>;
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
        focus: runtimeOptions?.focus ?? { kind: "overview" },
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
    async find(document, query, runtimeOptions) {
      if (runtimeOptions?.signal?.aborted) {
        throw new AgentCoreError("CANCELLED", "Find aborted");
      }
      if (options.find) {
        return options.find(document, query, runtimeOptions);
      }
      return unsupportedCapabilityFind(Capabilities.DocumentFind);
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
