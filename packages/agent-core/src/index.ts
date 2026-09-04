/**
 * OpenSuite Agent Core — contracts and runtime interfaces.
 *
 * This package owns the agent execution model (messages, models, tools,
 * events, DocumentRuntime). It does NOT own persistence, HTTP, UI, or
 * Office internals. See docs/agent_core.md.
 *
 * Full agent loop / orchestration is intentionally not implemented yet.
 */

export type {
  CapabilityId,
  Diagnostic,
  DiagnosticSeverity,
  DocumentFormat,
  DocumentRef,
  NonEmptyDiagnostics,
  RuntimeCapabilities,
  SemanticTarget,
} from "./types.js";
export {
  Capabilities,
  createCapabilities,
  hasCapability,
  listCapabilities,
} from "./types.js";

export type { AgentCoreErrorCode } from "./errors.js";
export { AgentCoreError, isAbortError } from "./errors.js";

export type {
  AgentMessage,
  AgentMessageRole,
  AgentRequest,
  AgentResource,
  AgentResult,
  AgentResultStatus,
  SteeringMessage,
  ToolOutcome,
} from "./request.js";

export type { AgentRunContext } from "./context.js";
export { createAgentRunContext } from "./context.js";

export type {
  AgentModel,
  AgentTool,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolInputSchema,
  ToolRisk,
} from "./model.js";
export { requiresConfirmation, toModelToolDefinition } from "./model.js";

export { ToolRegistry } from "./tools.js";

export type { AgentEvent, AgentEventSink } from "./events.js";
export { createRecordingEventSink, noopEventSink } from "./events.js";

export type {
  DocumentInspectionSummary,
  DocumentOperation,
  DocumentRuntime,
  DocumentRuntimeOptions,
  InspectionPayload,
  InspectionResult,
  OperationFailureCode,
  OperationResult,
} from "./runtime.js";
export {
  runtimeSupports,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
} from "./runtime.js";

export {
  assistantOnlyResponse,
  createFakeAgentModel,
  createFakeDocumentRuntime,
  createFakeTool,
  createFakeToolExecutionContext,
  toolCallResponse,
} from "./testing.js";
export type {
  FakeAgentModelOptions,
  FakeDocumentRuntimeOptions,
} from "./testing.js";
