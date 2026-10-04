import { jsonSchema } from 'ai';
import { z } from 'zod';
import { defineTool, type AgentToolSet } from '@opensuite/agent-core-v3';
import type { CapabilityDefinition } from '../core/registry.js';
import { styleProfileSummary, type StyleProfileService } from '../../../style-profiles/service.js';

export const styleProfileCapabilities: CapabilityDefinition[] = [
  { id: 'style', parentId: null, kind: 'group', title: 'Saved document styles', description: 'Learn and retrieve personal document style profiles', projection: 'dynamic' },
  { id: 'style.learn_from_document', parentId: 'style', kind: 'tool', title: 'Learn style from document', description: 'Save a reusable personal style profile from an exact saved DOCX version, only when the user explicitly asks to learn or save its style. Does not apply style or edit the document.', aliases: ['learn style save style personalization'], projection: 'dynamic', toolName: 'style.learn_from_document' },
  { id: 'style.list_profiles', parentId: 'style', kind: 'tool', title: 'List saved style profiles', description: 'Retrieve a bounded list of personal saved style summaries', projection: 'dynamic', toolName: 'style.list_profiles' },
  { id: 'style.get_profile', parentId: 'style', kind: 'tool', title: 'Get saved style profile', description: 'Retrieve a compact personal style profile summary by ID', projection: 'dynamic', toolName: 'style.get_profile' },
];

export function createStyleProfileTools(input: {
  profiles: StyleProfileService;
  ownerUserId: string;
  workspaceId: string;
  currentDocument: () => { documentId: string | null; versionId: string | null; dirty: boolean };
}): AgentToolSet {
  const learnSchema = z.object({ documentId: z.uuid().optional(), versionId: z.uuid().optional(), name: z.string().trim().min(1).max(160).optional() }).strict();
  return {
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
