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
  ToolEffect,
  ToolExecutionContext,
  ToolExecutionMode,
  ToolInputSchema,
  ToolRisk,
} from "./model.js";
export {
  requiresConfirmation,
  toolEffect,
  toolExecutionMode,
  toModelToolDefinition,
} from "./model.js";

export { ToolRegistry } from "./tools.js";

export type { AgentEvent, AgentEventSink } from "./events.js";
export { createRecordingEventSink, noopEventSink } from "./events.js";

export type {
  DocumentChangeSummary,
  DocumentFindQuery,
  DocumentInspectFocus,
  DocumentInspectOptions,
  DocumentInspectionSummary,
  DocumentOperation,
  DocumentRuntime,
  DocumentRuntimeOptions,
  FindMatch,
  FindResult,
  InspectedBlock,
  InspectedCell,
  InspectedHeading,
  InspectedSheet,
  InspectedSlide,
  InspectedTable,
  InspectionPayload,
  InspectionResult,
  OperationFailureCode,
  OperationResult,
} from "./runtime.js";
export {
  runtimeSupports,
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
} from "./runtime.js";

export {
  MOCK_DOCUMENT_CAPABILITIES,
  MOCK_MUTABLE_DOCUMENT_CAPABILITIES,
  createMockDocumentRuntime,
  mockBaseHeadingText,
  mockFixtureTitle,
} from "./mock-runtime.js";
export type { MockDocumentRuntimeOptions } from "./mock-runtime.js";

export {
  DOCUMENT_TOOL_NAMES,
  createDocumentCapabilitiesTool,
  createDocumentFindTool,
  createDocumentInspectTool,
  createDocumentReplaceTextTool,
  createDocumentToolRegistry,
  createSlidesUpdateTextTool,
  createWorkbookSetCellsTool,
  mutableDocumentCapabilities,
  readOnlyDocumentCapabilities,
} from "./document-tools.js";
export type {
  DocumentFindToolInput,
  DocumentInspectToolInput,
  DocumentReplaceTextInput,
  SlidesUpdateTextInput,
  WorkbookSetCellsInput,
} from "./document-tools.js";

export { buildDocumentAgentSystemPrompt } from "./instructions.js";

export type { ConfirmationGate, ConfirmationRequest } from "./confirmation.js";
export {
  AutoApproveConfirmationGate,
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
