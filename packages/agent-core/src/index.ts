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
  DocumentAffordance,
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
  shapeDiagnosticForToolResult,
} from "./types.js";

export type { AgentCoreErrorCode } from "./errors.js";
export { AgentCoreError, isAbortError } from "./errors.js";

export {
  ArtifactHandleRegistry,
  collectOpaqueHandles,
  collectOpaqueHandlesFromToolInput,
  requireCurrentArtifactHandles,
} from "./artifact-handles.js";

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
  ModelResponseMeta,
  ModelTokenUsage,
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

export {
  compactHistoricalToolCallArgs,
  projectToolResultForModel,
  summarizeExecutedToolArgs,
  transformContext,
} from "./model-context.js";
export type { ModelFacingToolProjection } from "./model-context.js";

export {
  elapsedMs,
  measureJsonBytes,
  measureMessagesBytes,
  measureToolArgumentBytes,
  measureToolCatalogBytes,
} from "./telemetry.js";

export {
  buildBenchmarkRecord,
  formatBenchmarkSummaryRow,
} from "./benchmark.js";
export type {
  BenchmarkAggregate,
  BenchmarkModelTurn,
  BenchmarkRunRecord,
  BenchmarkToolCall,
  BuildBenchmarkRecordInput,
} from "./benchmark.js";

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
  DocxInspectionOverview,
  FindMatch,
  FindResult,
  InspectedArtifactAffordances,
  InspectedBlock,
  InspectedBodyBlock,
  InspectedCell,
  InspectedHeading,
  InspectedSheet,
  InspectedSlide,
  InspectedTable,
  InspectedTableCell,
  InspectedTableColumn,
  InspectedTableRow,
  InspectedTextContext,
  InspectedTextContextUnit,
  InspectionPageInfo,
  InspectionPayload,
  InspectionResult,
  OperationFailureCode,
  OperationResult,
} from "./runtime.js";
export {
  DEFAULT_INSPECT_PAGE_LIMIT,
  MAX_INSPECT_PAGE_LIMIT,
  runtimeSupports,
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
} from "./runtime.js";

export type {
  DocumentCreateTableMutationRequest,
  DocumentDeleteParagraphMutationRequest,
  DocumentDeleteTableColumnMutationRequest,
  DocumentDeleteTableMutationRequest,
  DocumentDeleteTableRowMutationRequest,
  DocumentInsertParagraphMutationRequest,
  DocumentInsertParagraphsMutationRequest,
  DocumentInsertTableColumnMutationRequest,
  DocumentInsertTableRowsMutationRequest,
  DocumentMutationExecutor,
  DocumentMutationResult,
  DocumentParagraphAlignment,
  DocumentParagraphPlacement,
  DocumentReplaceTextMutationRequest,
  DocumentSetParagraphFormattingMutationRequest,
  DocumentSetParagraphStyleMutationRequest,
  DocumentSetTableCellsTextMutationRequest,
  DocumentSetTextFormattingMutationRequest,
  DocumentTableCellHandleTarget,
  DocumentTableCellSemanticTarget,
  DocumentTableCellTarget,
  DocumentTableCellUpdate,
  DocumentTableRowAnchor,
  DocumentTableTarget,
  DocumentTextTarget,
  PersistedDocumentMutationToolResult,
  PersistedReplaceTextToolResult,
} from "./document-mutation.js";
export {
  createInMemoryDocumentMutationExecutor,
  isPersistedDocumentMutationToolResult,
  isPersistedReplaceTextToolResult,
} from "./document-mutation.js";

export {
  normalizeOptionalOccurrence,
  parseOptionalOccurrence,
} from "./occurrence.js";

export {
  MOCK_DOCUMENT_CAPABILITIES,
  MOCK_MUTABLE_DOCUMENT_CAPABILITIES,
  createMockDocumentRuntime,
  mockBaseHeadingText,
  mockFixtureTitle,
} from "./mock-runtime.js";
export type { MockDocumentRuntimeOptions } from "./mock-runtime.js";

export {
  DOCX_ENGINE_CAPS,
  DOCUMENT_TOOL_NAMES,
  MOCK_FORMAT_CAPS,
  createDocumentCapabilitiesTool,
  createDocumentCreateTableTool,
  createDocumentDeleteParagraphTool,
  createDocumentDeleteTableColumnTool,
  createDocumentDeleteTableRowTool,
  createDocumentDeleteTableTool,
  createDocumentFindTool,
  createDocumentInspectTool,
  createDocumentInsertParagraphTool,
  createDocumentInsertParagraphsTool,
  createDocumentInsertTableColumnTool,
  createDocumentInsertTableRowsTool,
  createDocumentReplaceTextTool,
  createDocumentSetParagraphFormattingTool,
  createDocumentSetParagraphStyleTool,
  createDocumentSetTableCellsTextTool,
  createDocumentSetTableFormattingTool,
  createDocumentSetTextFormattingTool,
  createDocumentToolRegistry,
  createSlidesUpdateTextTool,
  createWorkbookSetCellsTool,
  discoverDocumentToolsFromRuntime,
  filterDocumentToolsByCapabilities,
  listDocumentToolDescriptors,
  mockCapabilitiesForFormat,
  mutableDocumentCapabilities,
  readOnlyDocumentCapabilities,
} from "./document-tools.js";
export type {
  DocumentCreateTableInput,
  DocumentDeleteParagraphInput,
  DocumentDeleteTableColumnInput,
  DocumentDeleteTableInput,
  DocumentDeleteTableRowInput,
  DocumentFindToolInput,
  DocumentInsertParagraphInput,
  DocumentInsertParagraphsInput,
  DocumentInsertTableColumnInput,
  DocumentInsertTableRowsInput,
  DocumentInspectToolInput,
  DocumentReplaceTextInput,
  DocumentSetParagraphFormattingInput,
  DocumentSetParagraphStyleInput,
  DocumentSetTableCellsTextInput,
  DocumentSetTableFormattingInput,
  DocumentSetTextFormattingInput,
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
