import { jsonSchema } from 'ai';
import { z } from 'zod';
import { defineTool, type AgentToolSet } from '@opensuite/agent-core-v3';
import type { CapabilityDefinition } from '../core/registry.js';
import { styleProfileSummary, type StyleProfileService } from '../../../style-profiles/service.js';

export const styleProfileCapabilities: CapabilityDefinition[] = [
  { id: 'style', parentId: null, kind: 'group', title: 'Saved document styles', description: 'Learn, retrieve, and apply personal document style profiles', projection: 'dynamic' },
  { id: 'style.learn_from_document', parentId: 'style', kind: 'tool', title: 'Learn style from document', description: 'Save a reusable personal style profile from an exact saved DOCX version, only when the user explicitly asks to learn or save its style. Does not apply style or edit the document.', aliases: ['learn style save style personalization'], projection: 'dynamic', toolName: 'style.learn_from_document' },
  { id: 'style.list_profiles', parentId: 'style', kind: 'tool', title: 'List saved style profiles', description: 'Retrieve a bounded list of personal saved style summaries', projection: 'dynamic', toolName: 'style.list_profiles' },
  { id: 'style.get_profile', parentId: 'style', kind: 'tool', title: 'Get saved style profile', description: 'Retrieve a compact personal style profile summary by ID', projection: 'dynamic', toolName: 'style.get_profile' },
  { id: 'style.apply_profile', parentId: 'style', kind: 'tool', title: 'Apply saved style profile', description: 'Resolve an accessible saved profile by ID and apply supported formatting to the selected working DOCX. Preserves content and verifies style fidelity. Use after creating/editing semantic content, before finishing.', projection: 'dynamic', toolName: 'style.apply_profile' },
];

export function createStyleProfileTools(input: {
  profiles: StyleProfileService;
  ownerUserId: string;
  workspaceId: string;
  applyProfile?: (profileId: string) => Promise<unknown>;
  currentDocument: () => { documentId: string | null; versionId: string | null; dirty: boolean };
}): AgentToolSet {
  const learnSchema = z.object({ documentId: z.uuid().optional(), versionId: z.uuid().optional(), name: z.string().trim().min(1).max(160).optional() }).strict();
  return {
    ...(input.applyProfile ? { 'style.apply_profile': defineTool<{ id: string }, unknown>({
      kind: 'mutate', description: styleProfileCapabilities[4]!.description,
      inputSchema: jsonSchema({ type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false }),
      execute: args => input.applyProfile!(z.object({ id: z.uuid() }).strict().parse(args).id),
    }) } : {}),
    'style.learn_from_document': defineTool<{ documentId?: string; versionId?: string; name?: string }, unknown>({
      kind: 'mutate', description: styleProfileCapabilities[1]!.description + ' Omit IDs to use the selected saved version. Unsaved edits cannot be learned until a later run.',
      inputSchema: jsonSchema({ type: 'object', properties: { documentId: { type: 'string', format: 'uuid' }, versionId: { type: 'string', format: 'uuid' }, name: { type: 'string', minLength: 1, maxLength: 160 } }, additionalProperties: false }),
      execute: async args => {
        const parsed = learnSchema.parse(args);
        const current = input.currentDocument();
        const documentId = parsed.documentId ?? current.documentId;
        if (!documentId) throw new Error('Select a source document or provide documentId');
        if (documentId === current.documentId && current.dirty) throw new Error('The selected document has unsaved edits. Learn its saved style in a later run.');
        const versionId = parsed.versionId ?? (documentId === current.documentId ? current.versionId ?? undefined : undefined);
        return styleProfileSummary(await input.profiles.learnFromDocument({ ...parsed, documentId, ...(versionId ? { versionId } : {}), ownerUserId: input.ownerUserId, workspaceId: input.workspaceId }));
      },
    }),
    'style.list_profiles': defineTool<{ offset?: number }, unknown>({
      kind: 'read', description: styleProfileCapabilities[2]!.description,
      inputSchema: jsonSchema({ type: 'object', properties: { offset: { type: 'integer', minimum: 0, maximum: 100000 } }, additionalProperties: false }),
      execute: args => input.profiles.list(input.ownerUserId, 10, z.object({ offset: z.number().int().min(0).max(100000).default(0) }).strict().parse(args).offset),
    }),
    'style.get_profile': defineTool<{ id: string }, unknown>({
      kind: 'read', description: styleProfileCapabilities[3]!.description,
      inputSchema: jsonSchema({ type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'], additionalProperties: false }),
      execute: async args => styleProfileSummary(await input.profiles.get(input.ownerUserId, z.object({ id: z.uuid() }).strict().parse(args).id)),
    }),
  };
}

/** Named/personal style use, excluding generic requests such as “use an appropriate visual style”. */
export function requestsSavedStyle(instruction: string): boolean {
  return /\b(?:use|using|apply|with)\b[^.\n]{0,160}\b(?:saved|profile)\b[^.\n]{0,80}\bstyle\b/i.test(instruction)
    || /\b(?:use|using|apply|with)\s+(?:my|our|the saved)\s+[^.\n]{0,140}\bstyle\b/i.test(instruction)
    || /\b(?:[Uu]se|[Uu]sing|[Aa]pply)\s+(?!(?:an?\s+)?(?:appropriate|generic|visual|professional|clean|built-in)\b)(?:the\s+|this\s+)?[A-Z][^.!?\n]{1,100}\bStyle\b/.test(instruction)
    || /\b(?:use|using|apply)\b[^.\n]{0,100}\bstyle\s+profile\b/i.test(instruction);
}
