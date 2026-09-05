/**
 * OpenSuite Agent Core — contracts, runtime interfaces, and AgentRunner.
 *
 * This package owns the agent execution model (messages, models, tools,
 * events, DocumentRuntime, runner loop). It does NOT own persistence, HTTP,
 * UI, or Office internals. See docs/agent_core.md.
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
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelToolDefinition,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolInputSchema,
  ToolRisk,
} from "./model.js";
export {
  requiresConfirmation,
  toolExecutionMode,
  toModelToolDefinition,
} from "./model.js";

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

export type { ConfirmationGate, ConfirmationRequest } from "./confirmation.js";
export {
  autoApproveConfirmationGate,
  createScriptedConfirmationGate,
  denyAllConfirmationGate,
} from "./confirmation.js";

export type { SteeringSource } from "./steering.js";
export { InMemorySteeringQueue } from "./steering.js";

export type { AgentRunOptions, AgentRunnerOptions } from "./runner.js";
export { AgentRunner } from "./runner.js";

export {
  assistantOnlyResponse,
  createFakeAgentModel,
  createFakeDocumentRuntime,
  createFakeTool,
  createFakeToolExecutionContext,
  createScriptedAgentModel,
  delay,
  toolCallResponse,
} from "./testing.js";
export type {
  FakeAgentModelOptions,
  FakeDocumentRuntimeOptions,
} from "./testing.js";
