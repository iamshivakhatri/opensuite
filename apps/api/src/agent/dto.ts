import type {
  AgentMessage,
  AgentRun,
  AgentStep,
  AgentThread,
} from "./persistence.js";

/** Public thread DTO — no createdByUserId / archivedAt unless product needs them. */
export interface AgentThreadDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentMessageDto {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
}

export interface AgentRunDto {
  readonly id: string;
  readonly threadId: string;
  readonly status: AgentRun["status"];
  readonly baseDocumentVersionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** Concise step DTO — no tool input/output JSON in v1 HTTP responses. */
export interface AgentStepDto {
  readonly id: string;
  readonly sequence: number;
  readonly kind: AgentStep["kind"];
  readonly status: AgentStep["status"];
  readonly name: string;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export function toAgentThreadDto(thread: AgentThread): AgentThreadDto {
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    documentId: thread.documentId,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

export function toAgentMessageDto(message: AgentMessage): AgentMessageDto {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
  };
}

export function toAgentRunDto(run: AgentRun): AgentRunDto {
  return {
    id: run.id,
    threadId: run.threadId,
    status: run.status,
    baseDocumentVersionId: run.baseDocumentVersionId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

export function toAgentStepDto(step: AgentStep): AgentStepDto {
  return {
    id: step.id,
    sequence: step.sequence,
    kind: step.kind,
    status: step.status,
    name: step.name,
    summary: step.summary,
    createdAt: step.createdAt,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
  };
}
