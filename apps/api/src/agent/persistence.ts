import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";

import type { Db } from "@opensuite/db";
import { schema } from "@opensuite/db";

/** Db or an active transaction — callers can compose atomic multi-writes later. */
export type AgentPersistenceExecutor = Db;

export type AgentMessageRole = "user" | "assistant";

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_for_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentStepKind =
  | "narration"
  | "plan"
  | "inspect"
  | "tool"
  | "confirmation"
  | "validation"
  | "final";

export type AgentStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export const THREAD_CONTEXT_CHECKPOINT_CONTENT_VERSION = 1;
export const MAX_CHECKPOINT_CHARACTERS = 16_000;

export interface AgentThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly createdByUserId: string | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface AgentMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: AgentMessageRole;
  readonly content: string;
  readonly documentIds?: readonly string[];
  readonly createdAt: string;
}

export interface AgentRun {
  readonly id: string;
  readonly threadId: string;
  readonly triggeringMessageId: string | null;
  readonly createdByUserId: string | null;
  readonly baseDocumentVersionId: string | null;
  readonly resultMessageId: string | null;
  readonly status: AgentRunStatus;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface AgentThreadContextCheckpoint {
  readonly id: string;
  readonly threadId: string;
  readonly throughMessageId: string;
  readonly throughMessageCreatedAt: string;
  readonly contentVersion: number;
  readonly content: string;
  readonly sourceMessageCount: number;
  readonly estimatedCharacters: number;
  readonly createdAt: string;
}

export interface AgentStep {
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly kind: AgentStepKind;
  readonly status: AgentStepStatus;
  readonly name: string;
  readonly summary: string | null;
  readonly input: Record<string, unknown> | null;
  readonly output: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export type AgentPersistenceErrorCode =
  | "THREAD_NOT_FOUND"
  | "WORKSPACE_NOT_FOUND"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_WORKSPACE_MISMATCH"
  | "MESSAGE_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "STEP_NOT_FOUND"
  | "CHECKPOINT_MESSAGE_NOT_FOUND"
  | "CHECKPOINT_MESSAGE_THREAD_MISMATCH"
  | "CHECKPOINT_CONTENT_TOO_LARGE"
  | "INVALID_RUN_STATUS_TRANSITION"
  | "INVALID_STEP_STATUS_TRANSITION"
  | "STEP_SEQUENCE_CONFLICT";

export class AgentPersistenceError extends Error {
  readonly code: AgentPersistenceErrorCode;

  constructor(code: AgentPersistenceErrorCode, message: string) {
    super(message);
    this.name = "AgentPersistenceError";
    this.code = code;
  }
}

/**
 * Allowed run status edges. Terminal states have no outgoing edges.
 * waiting_for_confirmation → running covers the resume path.
 */
const RUN_STATUS_TRANSITIONS: Readonly<
  Record<AgentRunStatus, readonly AgentRunStatus[]>
> = {
  queued: ["planning", "running", "failed", "cancelled"],
  planning: ["running", "waiting_for_confirmation", "failed", "cancelled"],
  running: [
    "waiting_for_confirmation",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_for_confirmation: ["running", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

const STEP_STATUS_TRANSITIONS: Readonly<
  Record<AgentStepStatus, readonly AgentStepStatus[]>
> = {
  pending: ["running", "cancelled", "failed"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const TERMINAL_RUN_STATUSES: ReadonlySet<AgentRunStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_STEP_STATUSES: ReadonlySet<AgentStepStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function toThread(row: {
  id: string;
  workspaceId: string;
  documentId: string | null;
  createdByUserId: string | null;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}): AgentThread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    documentId: row.documentId,
    createdByUserId: row.createdByUserId,
    title: row.title,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: toIso(row.archivedAt),
  };
}

function toMessage(row: {
  id: string;
  threadId: string;
  role: AgentMessageRole;
  content: string;
  documentIds: string[];
  createdAt: Date;
}): AgentMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    documentIds: row.documentIds,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRun(row: {
  id: string;
  threadId: string;
  triggeringMessageId: string | null;
  createdByUserId: string | null;
  baseDocumentVersionId: string | null;
  resultMessageId: string | null;
  status: AgentRunStatus;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
}): AgentRun {
  return {
    id: row.id,
    threadId: row.threadId,
    triggeringMessageId: row.triggeringMessageId,
    createdByUserId: row.createdByUserId,
    baseDocumentVersionId: row.baseDocumentVersionId,
    resultMessageId: row.resultMessageId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

function toThreadContextCheckpoint(row: {
  id: string;
  threadId: string;
  throughMessageId: string;
  throughMessageCreatedAt: Date;
  contentVersion: number;
  content: string;
  sourceMessageCount: number;
  estimatedCharacters: number;
  createdAt: Date;
}): AgentThreadContextCheckpoint {
  return {
    id: row.id,
    threadId: row.threadId,
    throughMessageId: row.throughMessageId,
    throughMessageCreatedAt: row.throughMessageCreatedAt.toISOString(),
    contentVersion: row.contentVersion,
    content: row.content,
    sourceMessageCount: row.sourceMessageCount,
    estimatedCharacters: row.estimatedCharacters,
    createdAt: row.createdAt.toISOString(),
  };
}

function toStep(row: {
  id: string;
  runId: string;
  sequence: number;
  kind: AgentStepKind;
  status: AgentStepStatus;
  name: string;
  summary: string | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}): AgentStep {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    kind: row.kind,
    status: row.status,
    name: row.name,
    summary: row.summary,
    input: row.input,
    output: row.output,
    createdAt: row.createdAt.toISOString(),
    startedAt: toIso(row.startedAt),
    completedAt: toIso(row.completedAt),
  };
}

const threadSelect = {
  id: schema.agentThread.id,
  workspaceId: schema.agentThread.workspaceId,
  documentId: schema.agentThread.documentId,
  createdByUserId: schema.agentThread.createdByUserId,
  title: schema.agentThread.title,
  createdAt: schema.agentThread.createdAt,
  updatedAt: schema.agentThread.updatedAt,
  archivedAt: schema.agentThread.archivedAt,
} as const;

const messageSelect = {
  id: schema.agentMessage.id,
  threadId: schema.agentMessage.threadId,
  role: schema.agentMessage.role,
  content: schema.agentMessage.content,
  documentIds: schema.agentMessage.documentIds,
  createdAt: schema.agentMessage.createdAt,
} as const;

const runSelect = {
  id: schema.agentRun.id,
  threadId: schema.agentRun.threadId,
  triggeringMessageId: schema.agentRun.triggeringMessageId,
  createdByUserId: schema.agentRun.createdByUserId,
  baseDocumentVersionId: schema.agentRun.baseDocumentVersionId,
  resultMessageId: schema.agentRun.resultMessageId,
  status: schema.agentRun.status,
  createdAt: schema.agentRun.createdAt,
  startedAt: schema.agentRun.startedAt,
  completedAt: schema.agentRun.completedAt,
  errorCode: schema.agentRun.errorCode,
  errorMessage: schema.agentRun.errorMessage,
} as const;

const checkpointSelect = {
  id: schema.agentThreadContextCheckpoint.id,
  threadId: schema.agentThreadContextCheckpoint.threadId,
  throughMessageId: schema.agentThreadContextCheckpoint.throughMessageId,
  throughMessageCreatedAt: schema.agentThreadContextCheckpoint.throughMessageCreatedAt,
  contentVersion: schema.agentThreadContextCheckpoint.contentVersion,
  content: schema.agentThreadContextCheckpoint.content,
  sourceMessageCount: schema.agentThreadContextCheckpoint.sourceMessageCount,
  estimatedCharacters: schema.agentThreadContextCheckpoint.estimatedCharacters,
  createdAt: schema.agentThreadContextCheckpoint.createdAt,
} as const;

const stepSelect = {
  id: schema.agentStep.id,
  runId: schema.agentStep.runId,
  sequence: schema.agentStep.sequence,
  kind: schema.agentStep.kind,
  status: schema.agentStep.status,
  name: schema.agentStep.name,
  summary: schema.agentStep.summary,
  input: schema.agentStep.input,
  output: schema.agentStep.output,
  createdAt: schema.agentStep.createdAt,
  startedAt: schema.agentStep.startedAt,
  completedAt: schema.agentStep.completedAt,
} as const;

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const code = "code" in error ? error.code : undefined;
  if (code === "23505") {
    return true;
  }

  const cause =
    "cause" in error && error.cause && typeof error.cause === "object"
      ? error.cause
      : null;
  return cause !== null && "code" in cause && cause.code === "23505";
}

/**
 * Durable agent conversation/run/step persistence.
 * Ownership: agent_thread → workspace → owner_user_id.
 * Does not import Fastify or agent-core.
 */
export function createAgentPersistenceService(db: Db) {
  function executor(tx?: AgentPersistenceExecutor): AgentPersistenceExecutor {
    return tx ?? db;
  }

  async function requireOwnedThread(
    client: AgentPersistenceExecutor,
    threadId: string,
    ownerUserId: string,
  ): Promise<AgentThread> {
    const [row] = await client
      .select(threadSelect)
      .from(schema.agentThread)
      .innerJoin(
        schema.workspace,
        eq(schema.agentThread.workspaceId, schema.workspace.id),
      )
      .leftJoin(
        schema.document,
        eq(schema.agentThread.documentId, schema.document.id),
      )
      .where(
        and(
          eq(schema.agentThread.id, threadId),
          eq(schema.workspace.ownerUserId, ownerUserId),
          isNull(schema.workspace.deletedAt),
          or(
            isNull(schema.agentThread.documentId),
            and(
              isNotNull(schema.document.id),
              isNull(schema.document.deletedAt),
            ),
          ),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AgentPersistenceError(
        "THREAD_NOT_FOUND",
        "Agent thread not found",
      );
    }

    return toThread(row);
  }

  async function touchThread(
    client: AgentPersistenceExecutor,
    threadId: string,
  ): Promise<void> {
    await client
      .update(schema.agentThread)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentThread.id, threadId));
  }

  async function getRun(
    input: { runId: string; ownerUserId: string },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentRun | null> {
    const client = executor(tx);
    const [row] = await client
      .select(runSelect)
      .from(schema.agentRun)
      .innerJoin(
        schema.agentThread,
        eq(schema.agentRun.threadId, schema.agentThread.id),
      )
      .innerJoin(
        schema.workspace,
        eq(schema.agentThread.workspaceId, schema.workspace.id),
      )
      .leftJoin(
        schema.document,
        eq(schema.agentThread.documentId, schema.document.id),
      )
      .where(
        and(
          eq(schema.agentRun.id, input.runId),
          eq(schema.workspace.ownerUserId, input.ownerUserId),
          isNull(schema.workspace.deletedAt),
          or(
            isNull(schema.agentThread.documentId),
            and(
              isNotNull(schema.document.id),
              isNull(schema.document.deletedAt),
            ),
          ),
        ),
      )
      .limit(1);

    return row ? toRun(row) : null;
  }

  async function updateRunStatus(
    input: {
      runId: string;
      ownerUserId: string;
      status: AgentRunStatus;
      errorCode?: string | null;
      errorMessage?: string | null;
      resultMessageId?: string | null;
    },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentRun> {
    const client = executor(tx);
    const existing = await getRun(
      { runId: input.runId, ownerUserId: input.ownerUserId },
      client,
    );

    if (!existing) {
      throw new AgentPersistenceError("RUN_NOT_FOUND", "Agent run not found");
    }

    const allowed = RUN_STATUS_TRANSITIONS[existing.status];
    if (!allowed.includes(input.status)) {
      throw new AgentPersistenceError(
        "INVALID_RUN_STATUS_TRANSITION",
        `Cannot transition agent run from ${existing.status} to ${input.status}`,
      );
    }

    const now = new Date();
    const patch: {
      status: AgentRunStatus;
      startedAt?: Date;
      completedAt?: Date;
      errorCode?: string | null;
      errorMessage?: string | null;
      resultMessageId?: string | null;
    } = { status: input.status };

    if (input.resultMessageId !== undefined) {
      patch.resultMessageId = input.resultMessageId;
    }

    if (existing.startedAt === null && input.status !== "queued") {
      patch.startedAt = now;
    }

    if (TERMINAL_RUN_STATUSES.has(input.status)) {
      patch.completedAt = now;
    }

    if (input.status === "failed") {
      patch.errorCode = input.errorCode ?? "FAILED";
      patch.errorMessage = input.errorMessage ?? "Agent run failed";
    } else if (
      input.errorCode !== undefined ||
      input.errorMessage !== undefined
    ) {
      patch.errorCode = input.errorCode ?? null;
      patch.errorMessage = input.errorMessage ?? null;
    }

    const [row] = await client
      .update(schema.agentRun)
      .set(patch)
      .where(eq(schema.agentRun.id, input.runId))
      .returning(runSelect);

    if (!row) {
      throw new AgentPersistenceError("RUN_NOT_FOUND", "Agent run not found");
    }

    await touchThread(client, existing.threadId);
    return toRun(row);
  }

  async function appendStep(
    input: {
      runId: string;
      ownerUserId: string;
      sequence: number;
      kind: AgentStepKind;
      name: string;
      status?: AgentStepStatus;
      summary?: string | null;
      input?: Record<string, unknown> | null;
      output?: Record<string, unknown> | null;
    },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentStep> {
    const client = executor(tx);
    const run = await getRun(
      { runId: input.runId, ownerUserId: input.ownerUserId },
      client,
    );

    if (!run) {
      throw new AgentPersistenceError("RUN_NOT_FOUND", "Agent run not found");
    }

    const status = input.status ?? "pending";
    const now = new Date();

    try {
      const [row] = await client
        .insert(schema.agentStep)
        .values({
          runId: input.runId,
          sequence: input.sequence,
          kind: input.kind,
          name: input.name,
          status,
          summary: input.summary ?? null,
          input: input.input ?? null,
          output: input.output ?? null,
          startedAt: status === "pending" ? null : now,
          completedAt: TERMINAL_STEP_STATUSES.has(status) ? now : null,
        })
        .returning(stepSelect);

      if (!row) {
        throw new Error("Failed to append agent step");
      }

      return toStep(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentPersistenceError(
          "STEP_SEQUENCE_CONFLICT",
          "Agent step sequence already exists for this run",
        );
      }
      throw error;
    }
  }

  async function appendSteps(
    input: {
      runId: string;
      ownerUserId: string;
      steps: readonly {
        sequence: number;
        kind: AgentStepKind;
        name: string;
        status: AgentStepStatus;
        summary?: string | null;
      }[];
    },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentStep[]> {
    if (input.steps.length === 0) return [];
    const client = executor(tx);
    const run = await getRun({ runId: input.runId, ownerUserId: input.ownerUserId }, client);
    if (!run) throw new AgentPersistenceError("RUN_NOT_FOUND", "Agent run not found");
    const now = new Date();
    try {
      const rows = await client
        .insert(schema.agentStep)
        .values(input.steps.map((step) => ({
          runId: input.runId,
          sequence: step.sequence,
          kind: step.kind,
          name: step.name,
          status: step.status,
          summary: step.summary ?? null,
          input: null,
          output: null,
          startedAt: now,
          completedAt: TERMINAL_STEP_STATUSES.has(step.status) ? now : null,
        })))
        .returning(stepSelect);
      return rows.map(toStep);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AgentPersistenceError("STEP_SEQUENCE_CONFLICT", "Agent step sequence already exists for this run");
      }
      throw error;
    }
  }

  async function updateStepStatus(
    input: {
      stepId: string;
      ownerUserId: string;
      status: AgentStepStatus;
      summary?: string | null;
      output?: Record<string, unknown> | null;
    },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentStep> {
    const client = executor(tx);
    const [existing] = await client
      .select(stepSelect)
      .from(schema.agentStep)
      .innerJoin(
        schema.agentRun,
        eq(schema.agentStep.runId, schema.agentRun.id),
      )
      .innerJoin(
        schema.agentThread,
        eq(schema.agentRun.threadId, schema.agentThread.id),
      )
      .innerJoin(
        schema.workspace,
        eq(schema.agentThread.workspaceId, schema.workspace.id),
      )
      .where(
        and(
          eq(schema.agentStep.id, input.stepId),
          eq(schema.workspace.ownerUserId, input.ownerUserId),
          isNull(schema.workspace.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) {
      throw new AgentPersistenceError("STEP_NOT_FOUND", "Agent step not found");
    }

    const allowed = STEP_STATUS_TRANSITIONS[existing.status];
    if (!allowed.includes(input.status)) {
      throw new AgentPersistenceError(
        "INVALID_STEP_STATUS_TRANSITION",
        `Cannot transition agent step from ${existing.status} to ${input.status}`,
      );
    }

    const now = new Date();
    const patch: {
      status: AgentStepStatus;
      startedAt?: Date;
      completedAt?: Date;
      summary?: string | null;
      output?: Record<string, unknown> | null;
    } = { status: input.status };

    if (existing.startedAt === null && input.status !== "pending") {
      patch.startedAt = now;
    }

    if (TERMINAL_STEP_STATUSES.has(input.status)) {
      patch.completedAt = now;
    }

    if (input.summary !== undefined) {
      patch.summary = input.summary;
    }

    if (input.output !== undefined) {
      patch.output = input.output;
    }

    const [row] = await client
      .update(schema.agentStep)
      .set(patch)
      .where(eq(schema.agentStep.id, input.stepId))
      .returning(stepSelect);

    if (!row) {
      throw new AgentPersistenceError("STEP_NOT_FOUND", "Agent step not found");
    }

    return toStep(row);
  }

  async function listStepsForRun(
    input: { runId: string; ownerUserId: string },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentStep[]> {
    const client = executor(tx);
    const run = await getRun(
      { runId: input.runId, ownerUserId: input.ownerUserId },
      client,
    );

    if (!run) {
      throw new AgentPersistenceError("RUN_NOT_FOUND", "Agent run not found");
    }

    const rows = await client
      .select(stepSelect)
      .from(schema.agentStep)
      .where(eq(schema.agentStep.runId, input.runId))
      .orderBy(asc(schema.agentStep.sequence), asc(schema.agentStep.id));

    return rows.map(toStep);
  }

  async function listRunsForResultMessages(
    input: { threadId: string; ownerUserId: string; messageIds: readonly string[] },
    tx?: AgentPersistenceExecutor,
  ): Promise<AgentRun[]> {
    if (input.messageIds.length === 0) return [];
    const client = executor(tx);
    await requireOwnedThread(client, input.threadId, input.ownerUserId);
    const rows = await client
      .select(runSelect)
      .from(schema.agentRun)
      .where(and(
        eq(schema.agentRun.threadId, input.threadId),
        inArray(schema.agentRun.resultMessageId, [...input.messageIds]),
      ));
    return rows.map(toRun);
  }

  return {
    /**
     * Run multiple persistence writes in one transaction.
     * Future flows (append message + create run) should use this.
     */
    withTransaction<T>(
      fn: (tx: AgentPersistenceExecutor) => Promise<T>,
    ): Promise<T> {
      return db.transaction((tx) => fn(tx as AgentPersistenceExecutor));
    },

    async createThread(
      input: {
        workspaceId: string;
        ownerUserId: string;
        documentId?: string | null;
        title?: string | null;
        createdByUserId: string;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentThread> {
      const client = executor(tx);

      const [ownedWorkspace] = await client
        .select({ id: schema.workspace.id })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.id, input.workspaceId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .limit(1);

      if (!ownedWorkspace) {
        throw new AgentPersistenceError(
          "WORKSPACE_NOT_FOUND",
          "Workspace not found",
        );
      }

      const documentId = input.documentId ?? null;
      if (documentId) {
        const [doc] = await client
          .select({
            id: schema.document.id,
            workspaceId: schema.document.workspaceId,
          })
          .from(schema.document)
          .where(
            and(
              eq(schema.document.id, documentId),
              isNull(schema.document.deletedAt),
            ),
          )
          .limit(1);

        if (!doc) {
          throw new AgentPersistenceError(
            "DOCUMENT_NOT_FOUND",
            "Document not found",
          );
        }

        if (doc.workspaceId !== input.workspaceId) {
          throw new AgentPersistenceError(
            "DOCUMENT_WORKSPACE_MISMATCH",
            "Document does not belong to the thread workspace",
          );
        }
      }

      const [row] = await client
        .insert(schema.agentThread)
        .values({
          workspaceId: input.workspaceId,
          documentId,
          createdByUserId: input.createdByUserId,
          title: input.title ?? null,
        })
        .returning(threadSelect);

      if (!row) {
        throw new Error("Failed to create agent thread");
      }

      return toThread(row);
    },

    async getOwnedThread(
      input: { threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentThread | null> {
      try {
        return await requireOwnedThread(
          executor(tx),
          input.threadId,
          input.ownerUserId,
        );
      } catch (error) {
        if (
          error instanceof AgentPersistenceError &&
          error.code === "THREAD_NOT_FOUND"
        ) {
          return null;
        }
        throw error;
      }
    },

    async renameThread(input: {
      threadId: string;
      ownerUserId: string;
      title: string;
    }): Promise<AgentThread> {
      const client = executor();
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const [row] = await client
        .update(schema.agentThread)
        .set({ title: input.title, updatedAt: new Date() })
        .where(eq(schema.agentThread.id, input.threadId))
        .returning(threadSelect);
      if (!row) throw new AgentPersistenceError("THREAD_NOT_FOUND", "Agent thread not found");
      return toThread(row);
    },

    /** Only fills a missing title, so an in-flight automatic title cannot win over a rename. */
    async setThreadTitleIfMissing(input: {
      threadId: string;
      title: string;
    }): Promise<boolean> {
      const [row] = await executor()
        .update(schema.agentThread)
        .set({ title: input.title, updatedAt: new Date() })
        .where(and(
          eq(schema.agentThread.id, input.threadId),
          or(isNull(schema.agentThread.title), eq(sql`btrim(${schema.agentThread.title})`, "")),
        ))
        .returning({ id: schema.agentThread.id });
      return row !== undefined;
    },

    async listWorkingDocumentIds(
      input: { threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<string[]> {
      const client = executor(tx);
      const thread = await requireOwnedThread(
        client,
        input.threadId,
        input.ownerUserId,
      );
      const rows = await client
        .select({ documentId: schema.agentThreadWorkingDocument.documentId })
        .from(schema.agentThreadWorkingDocument)
        .innerJoin(
          schema.document,
          eq(
            schema.agentThreadWorkingDocument.documentId,
            schema.document.id,
          ),
        )
        .where(
          and(
            eq(schema.agentThreadWorkingDocument.threadId, thread.id),
            eq(schema.document.workspaceId, thread.workspaceId),
            isNull(schema.document.deletedAt),
          ),
        );
      return rows.map((row) => row.documentId);
    },

    async addWorkingDocuments(
      input: {
        threadId: string;
        ownerUserId: string;
        documentIds: readonly string[];
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<void> {
      const documentIds = [...new Set(input.documentIds)];
      if (documentIds.length === 0) return;
      const client = executor(tx);
      const thread = await requireOwnedThread(
        client,
        input.threadId,
        input.ownerUserId,
      );
      const documents = await client
        .select({ id: schema.document.id })
        .from(schema.document)
        .where(
          and(
            inArray(schema.document.id, documentIds),
            eq(schema.document.workspaceId, thread.workspaceId),
            isNull(schema.document.deletedAt),
          ),
        );
      if (documents.length !== documentIds.length) {
        throw new AgentPersistenceError(
          "DOCUMENT_NOT_FOUND",
          "Document not found for agent working set",
        );
      }
      await client
        .insert(schema.agentThreadWorkingDocument)
        .values(documentIds.map((documentId) => ({ threadId: thread.id, documentId })))
        .onConflictDoNothing();
    },

    async listThreadsForWorkspace(
      input: {
        workspaceId: string;
        ownerUserId: string;
        includeArchived?: boolean;
        documentId?: string | null;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentThread[]> {
      const client = executor(tx);

      const [ownedWorkspace] = await client
        .select({ id: schema.workspace.id })
        .from(schema.workspace)
        .where(
          and(
            eq(schema.workspace.id, input.workspaceId),
            eq(schema.workspace.ownerUserId, input.ownerUserId),
            isNull(schema.workspace.deletedAt),
          ),
        )
        .limit(1);

      if (!ownedWorkspace) {
        throw new AgentPersistenceError(
          "WORKSPACE_NOT_FOUND",
          "Workspace not found",
        );
      }

      const conditions = [
        eq(schema.agentThread.workspaceId, input.workspaceId),
      ];

      if (!input.includeArchived) {
        conditions.push(isNull(schema.agentThread.archivedAt));
      }

      if (input.documentId !== undefined) {
        if (input.documentId === null) {
          conditions.push(isNull(schema.agentThread.documentId));
        } else {
          conditions.push(eq(schema.agentThread.documentId, input.documentId));
        }
      }

      const rows = await client
        .select(threadSelect)
        .from(schema.agentThread)
        .where(and(...conditions))
        .orderBy(
          desc(schema.agentThread.updatedAt),
          desc(schema.agentThread.createdAt),
        );

      return rows.map(toThread);
    },

    async archiveThread(
      input: { threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentThread> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);

      const [row] = await client
        .update(schema.agentThread)
        .set({
          archivedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.agentThread.id, input.threadId))
        .returning(threadSelect);

      if (!row) {
        throw new AgentPersistenceError(
          "THREAD_NOT_FOUND",
          "Agent thread not found",
        );
      }

      return toThread(row);
    },

    async appendMessage(
      input: {
        threadId: string;
        ownerUserId: string;
        role: AgentMessageRole;
        content: string;
        documentIds?: readonly string[];
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentMessage> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);

      const [row] = await client
        .insert(schema.agentMessage)
        .values({
          threadId: input.threadId,
          role: input.role,
          content: input.content,
          documentIds: [...new Set(input.documentIds ?? [])],
        })
        .returning(messageSelect);

      if (!row) {
        throw new Error("Failed to append agent message");
      }

      await touchThread(client, input.threadId);
      return toMessage(row);
    },

    async getMessageForThread(
      input: { messageId: string; threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentMessage | null> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const [row] = await client
        .select(messageSelect)
        .from(schema.agentMessage)
        .where(and(
          eq(schema.agentMessage.id, input.messageId),
          eq(schema.agentMessage.threadId, input.threadId),
        ))
        .limit(1);
      return row ? toMessage(row) : null;
    },

    async listMessagesForThread(
      input: { threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentMessage[]> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);

      const rows = await client
        .select(messageSelect)
        .from(schema.agentMessage)
        .where(eq(schema.agentMessage.threadId, input.threadId))
        .orderBy(
          asc(schema.agentMessage.createdAt),
          asc(schema.agentMessage.id),
        );

      return rows.map(toMessage);
    },

    /**
     * Cursor-paginated message page for GET /messages (C6). Scopes by
     * threadId, orders on the (thread_id, created_at, id) index, and never
     * materializes full thread history. When `before` is omitted, returns
     * the newest page; otherwise returns the page strictly preceding the
     * supplied (createdAt, id) cursor. Chronological order is restored
     * before returning.
     */
    async listMessagesPageForThread(
      input: {
        threadId: string;
        ownerUserId: string;
        limit: number;
        before?: { createdAt: string; id: string } | null;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<{
      messages: AgentMessage[];
      hasMore: boolean;
      oldestCursor: { createdAt: string; id: string } | null;
    }> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const boundary = input.before ? new Date(input.before.createdAt) : null;
      const rows = await client
        .select(messageSelect)
        .from(schema.agentMessage)
        .where(and(
          eq(schema.agentMessage.threadId, input.threadId),
          ...(input.before && boundary
            ? [or(
                lt(schema.agentMessage.createdAt, boundary),
                and(
                  eq(schema.agentMessage.createdAt, boundary),
                  lt(schema.agentMessage.id, input.before.id),
                ),
              )]
            : []),
        ))
        .orderBy(desc(schema.agentMessage.createdAt), desc(schema.agentMessage.id))
        .limit(input.limit + 1);

      const hasMore = rows.length > input.limit;
      const pageRowsNewestFirst = hasMore ? rows.slice(0, input.limit) : rows;
      const oldestRow = pageRowsNewestFirst[pageRowsNewestFirst.length - 1] ?? null;
      const messages = pageRowsNewestFirst.slice().reverse().map(toMessage);

      return {
        messages,
        hasMore,
        oldestCursor: oldestRow
          ? { createdAt: oldestRow.createdAt.toISOString(), id: oldestRow.id }
          : null,
      };
    },

    async createThreadContextCheckpoint(
      input: {
        threadId: string;
        ownerUserId: string;
        throughMessageId: string;
        content: string;
        sourceMessageCount: number;
        contentVersion?: number;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentThreadContextCheckpoint> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      if (input.content.length > MAX_CHECKPOINT_CHARACTERS) {
        throw new AgentPersistenceError(
          "CHECKPOINT_CONTENT_TOO_LARGE",
          `Checkpoint content must be at most ${MAX_CHECKPOINT_CHARACTERS} characters`,
        );
      }

      const [message] = await client
        .select({
          threadId: schema.agentMessage.threadId,
          createdAt: schema.agentMessage.createdAt,
        })
        .from(schema.agentMessage)
        .where(eq(schema.agentMessage.id, input.throughMessageId))
        .limit(1);

      if (!message) {
        throw new AgentPersistenceError(
          "CHECKPOINT_MESSAGE_NOT_FOUND",
          "Checkpoint boundary message not found",
        );
      }
      if (message.threadId !== input.threadId) {
        throw new AgentPersistenceError(
          "CHECKPOINT_MESSAGE_THREAD_MISMATCH",
          "Checkpoint boundary message is not on this thread",
        );
      }

      const [row] = await client
        .insert(schema.agentThreadContextCheckpoint)
        .values({
          threadId: input.threadId,
          throughMessageId: input.throughMessageId,
          throughMessageCreatedAt: message.createdAt,
          contentVersion:
            input.contentVersion ?? THREAD_CONTEXT_CHECKPOINT_CONTENT_VERSION,
          content: input.content,
          sourceMessageCount: input.sourceMessageCount,
          estimatedCharacters: input.content.length,
        })
        .returning(checkpointSelect);

      if (!row) throw new Error("Failed to create thread context checkpoint");
      return toThreadContextCheckpoint(row);
    },

    async getLatestThreadContextCheckpoint(
      input: { threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentThreadContextCheckpoint | null> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const [row] = await client
        .select(checkpointSelect)
        .from(schema.agentThreadContextCheckpoint)
        .innerJoin(
          schema.agentMessage,
          eq(
            schema.agentThreadContextCheckpoint.throughMessageId,
            schema.agentMessage.id,
          ),
        )
        .where(
          and(
            eq(schema.agentThreadContextCheckpoint.threadId, input.threadId),
            eq(
              schema.agentThreadContextCheckpoint.contentVersion,
              THREAD_CONTEXT_CHECKPOINT_CONTENT_VERSION,
            ),
            eq(
              schema.agentThreadContextCheckpoint.threadId,
              schema.agentMessage.threadId,
            ),
          ),
        )
        .orderBy(
          desc(schema.agentThreadContextCheckpoint.throughMessageCreatedAt),
          desc(schema.agentThreadContextCheckpoint.throughMessageId),
          desc(schema.agentThreadContextCheckpoint.createdAt),
          desc(schema.agentThreadContextCheckpoint.id),
        )
        .limit(1);
      return row ? toThreadContextCheckpoint(row) : null;
    },

    async listRecentMessagesForContext(
      input: {
        threadId: string;
        ownerUserId: string;
        checkpoint?: AgentThreadContextCheckpoint | null;
        excludeMessageId?: string;
        limit: number;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentMessage[]> {
      if (input.checkpoint && input.checkpoint.threadId !== input.threadId) {
        throw new AgentPersistenceError(
          "CHECKPOINT_MESSAGE_THREAD_MISMATCH",
          "Checkpoint does not belong to this thread",
        );
      }
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const boundary = input.checkpoint
        ? new Date(input.checkpoint.throughMessageCreatedAt)
        : null;
      const rows = await client
        .select(messageSelect)
        .from(schema.agentMessage)
        .where(and(
          eq(schema.agentMessage.threadId, input.threadId),
          ...(input.excludeMessageId
            ? [ne(schema.agentMessage.id, input.excludeMessageId)]
            : []),
          ...(input.checkpoint && boundary
            ? [or(
                gt(schema.agentMessage.createdAt, boundary),
                and(
                  eq(schema.agentMessage.createdAt, boundary),
                  gt(schema.agentMessage.id, input.checkpoint.throughMessageId),
                ),
              )]
            : []),
        ))
        .orderBy(desc(schema.agentMessage.createdAt), desc(schema.agentMessage.id))
        .limit(input.limit);
      return rows.reverse().map(toMessage);
    },

    async getThreadContextTailStats(
      input: {
        threadId: string;
        ownerUserId: string;
        checkpoint?: AgentThreadContextCheckpoint | null;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<{ messageCount: number; characterCount: number }> {
      if (input.checkpoint && input.checkpoint.threadId !== input.threadId) {
        throw new AgentPersistenceError(
          "CHECKPOINT_MESSAGE_THREAD_MISMATCH",
          "Checkpoint does not belong to this thread",
        );
      }
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const boundary = input.checkpoint
        ? new Date(input.checkpoint.throughMessageCreatedAt)
        : null;
      const [row] = await client
        .select({
          messageCount: sql<number>`count(*)::int`,
          characterCount: sql<number>`coalesce(sum(char_length(${schema.agentMessage.content})), 0)::int`,
        })
        .from(schema.agentMessage)
        .where(and(
          eq(schema.agentMessage.threadId, input.threadId),
          ...(input.checkpoint && boundary
            ? [or(
                gt(schema.agentMessage.createdAt, boundary),
                and(
                  eq(schema.agentMessage.createdAt, boundary),
                  gt(schema.agentMessage.id, input.checkpoint.throughMessageId),
                ),
              )]
            : []),
        ));
      return { messageCount: row?.messageCount ?? 0, characterCount: row?.characterCount ?? 0 };
    },

    async listOldestMessagesForContextCompaction(
      input: {
        threadId: string;
        ownerUserId: string;
        checkpoint?: AgentThreadContextCheckpoint | null;
        limit: number;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentMessage[]> {
      if (input.checkpoint && input.checkpoint.threadId !== input.threadId) {
        throw new AgentPersistenceError(
          "CHECKPOINT_MESSAGE_THREAD_MISMATCH",
          "Checkpoint does not belong to this thread",
        );
      }
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);
      const boundary = input.checkpoint
        ? new Date(input.checkpoint.throughMessageCreatedAt)
        : null;
      const rows = await client
        .select(messageSelect)
        .from(schema.agentMessage)
        .where(and(
          eq(schema.agentMessage.threadId, input.threadId),
          ...(input.checkpoint && boundary
            ? [or(
                gt(schema.agentMessage.createdAt, boundary),
                and(
                  eq(schema.agentMessage.createdAt, boundary),
                  gt(schema.agentMessage.id, input.checkpoint.throughMessageId),
                ),
              )]
            : []),
        ))
        .orderBy(asc(schema.agentMessage.createdAt), asc(schema.agentMessage.id))
        .limit(input.limit);
      return rows.map(toMessage);
    },

    /**
     * Newest run on an owned thread (by createdAt). Used for refresh recovery
     * when a run may still be active.
     */
    async getLatestRunForThread(
      input: { threadId: string; ownerUserId: string },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentRun | null> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);

      const [row] = await client
        .select(runSelect)
        .from(schema.agentRun)
        .where(eq(schema.agentRun.threadId, input.threadId))
        .orderBy(
          desc(schema.agentRun.createdAt),
          desc(schema.agentRun.id),
        )
        .limit(1);

      return row ? toRun(row) : null;
    },

    async createRun(
      input: {
        threadId: string;
        ownerUserId: string;
        createdByUserId: string;
        triggeringMessageId?: string | null;
        baseDocumentVersionId?: string | null;
        status?: AgentRunStatus;
      },
      tx?: AgentPersistenceExecutor,
    ): Promise<AgentRun> {
      const client = executor(tx);
      await requireOwnedThread(client, input.threadId, input.ownerUserId);

      const triggeringMessageId = input.triggeringMessageId ?? null;
      if (triggeringMessageId) {
        const [message] = await client
          .select({
            id: schema.agentMessage.id,
            threadId: schema.agentMessage.threadId,
          })
          .from(schema.agentMessage)
          .where(eq(schema.agentMessage.id, triggeringMessageId))
          .limit(1);

        if (!message || message.threadId !== input.threadId) {
          throw new AgentPersistenceError(
            "MESSAGE_NOT_FOUND",
            "Triggering message not found on this thread",
          );
        }
      }

      const status = input.status ?? "queued";
      const startedAt =
        status === "queued" || status === "cancelled" ? null : new Date();

      const [row] = await client
        .insert(schema.agentRun)
        .values({
          threadId: input.threadId,
          triggeringMessageId,
          createdByUserId: input.createdByUserId,
          baseDocumentVersionId: input.baseDocumentVersionId ?? null,
          status,
          startedAt,
        })
        .returning(runSelect);

      if (!row) {
        throw new Error("Failed to create agent run");
      }

      await touchThread(client, input.threadId);
      return toRun(row);
    },

    getRun,
    updateRunStatus,
    appendStep,
    appendSteps,
    updateStepStatus,
    listStepsForRun,
    listRunsForResultMessages,
  };
}

export type AgentPersistenceService = ReturnType<
  typeof createAgentPersistenceService
>;
