import type { SavedVisualObservation } from "./attachment-vision.js";
import { modelMessageSchema } from 'ai';
import { z } from 'zod';
import type { AgentContinuation, ToolCallMetric } from '@opensuite/agent-core';
import type { AgentPersistenceService, AgentRun } from './persistence.js';
import type { SavedDocxStyleState } from './docx-tools.js';

// Each physical run stores only its new messages. Parent steps retain the prefix.
export interface SavedContinuation {
  version: 1;
  visualObservations?: readonly SavedVisualObservation[];
  parentRunId?: string;
  messages: AgentContinuation['messages'];
  turns: number;
  failures: AgentContinuation['failures'];
  toolCalls: readonly ToolCallMetric[];
  system: string;
  initialMessageCount: number;
  retrievalMessage?: string;
  direct: boolean;
  context: { readonly safeInputBudgetTokens?: number };
  activeDocumentId: string | null;
  savedVersionId: string | null;
  savedDraftId?: string | null;
  styleState?: SavedDocxStyleState;
  createdDocumentId?: string | null;
  editedDocumentId?: string | null;
}

const savedSchema = z.object({
  visualObservations: z.array(z.object({
    ok: z.literal(true), visualReference: z.object({ attachmentId: z.string(), extractionId: z.string(), page: z.number().int().min(1).max(500).optional() }),
    evidenceType: z.literal("model_visual_observation"), untrusted: z.literal(true), model: z.string().max(300), resolvedModel: z.string().optional(),
    sha256: z.string().length(64), filename: z.string().max(1000), sourceWarnings: z.array(z.string().max(1000)).max(20),
    observation: z.string().max(3000), truncated: z.boolean(), warning: z.string().max(500),
  })).max(4).optional(),
  version: z.literal(1), parentRunId: z.string().optional(),
  messages: z.array(modelMessageSchema), turns: z.number().int().nonnegative(),
  failures: z.array(z.tuple([z.string(), z.number().int().positive()])),
  toolCalls: z.array(z.object({
    sequence: z.number().int().positive(), turn: z.number().int().positive(), toolName: z.string(),
    kind: z.enum(['read', 'mutate', 'other']), outcome: z.enum(['success', 'failure', 'cancelled']),
    durationMs: z.number(), failureCode: z.string().optional(), effectKeys: z.array(z.string()).optional(),
  })),
  system: z.string().optional(), initialMessageCount: z.number().int().positive().optional(), retrievalMessage: z.string().optional(),
  direct: z.boolean().optional(), context: z.object({ safeInputBudgetTokens: z.number().optional() }).passthrough().optional(),
  activeDocumentId: z.string().nullable(), savedVersionId: z.string().nullable(),
  savedDraftId: z.string().nullable().optional(),
  styleState: z.custom<SavedDocxStyleState>(value => !!value && typeof value === 'object' && 'appliedStyle' in value && 'styleFidelity' in value).optional(),
  createdDocumentId: z.string().nullable().optional(),
  editedDocumentId: z.string().nullable().optional(),
});

export async function loadRunContinuation(persistence: AgentPersistenceService, prior: AgentRun, ownerUserId: string,
  steps: Awaited<ReturnType<AgentPersistenceService['listStepsForRun']>>): Promise<SavedContinuation | undefined> {
  const segments: SavedContinuation[] = [];
  const seen = new Set<string>();
  let run = prior;
  for (;;) {
    if (seen.has(run.id)) throw new Error('Invalid saved continuation chain');
    seen.add(run.id);
    const value = [...steps].reverse().find(step => step.output?.continuation)?.output?.continuation;
    if (value === undefined && !segments.length) return undefined; // Older runs have no replayable transcript.
    const parsed = savedSchema.safeParse(value);
    if (!parsed.success) throw new Error('Saved continuation is unavailable');
    const saved = parsed.data as SavedContinuation;
    segments.unshift(saved);
    if (!saved.parentRunId) break;
    const parent = await persistence.getRun({ runId: saved.parentRunId, ownerUserId });
    if (!parent || parent.threadId !== prior.threadId || parent.triggeringMessageId !== prior.triggeringMessageId ||
      parent.status !== 'failed' || !['AGENT_MAX_TURNS', 'AGENT_DEADLINE'].includes(parent.errorCode ?? '')) {
      throw new Error('Saved continuation is unavailable');
    }
    run = parent;
    steps = await persistence.listStepsForRun({ runId: run.id, ownerUserId });
  }
  const root = segments[0]!;
  if (root.system === undefined || root.context === undefined || root.initialMessageCount === undefined || root.direct === undefined) {
    throw new Error('Saved continuation is unavailable');
  }
  const latest = { ...root, ...segments.at(-1)! };
  const messages = segments.flatMap(segment => segment.messages);
  if (Buffer.byteLength(JSON.stringify(messages)) > 32_000_000) throw new Error('Saved execution context exceeds the continuation size limit');
  if (latest.initialMessageCount > messages.length) throw new Error('Saved continuation is unavailable');
  return { ...latest, messages, toolCalls: segments.flatMap(segment => segment.toolCalls)
    .map((call, index) => ({ ...call, sequence: index + 1 })) };
}
