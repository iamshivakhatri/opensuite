import { jsonSchema } from 'ai';
import { defineTool, type AgentToolSet } from '@opensuite/agent-core';
import type { WorkspaceBrandProfile } from '@opensuite/contracts';
import type { CapabilityDefinition } from '../core/registry.js';

export const workspaceBrandCapabilities: CapabilityDefinition[] = [
  { id: 'workspace.get_brand', parentId: 'workspace', kind: 'tool', title: 'Read saved workspace brand', description: 'Read the company identity, colors, fonts, and logo ID saved in Brand & Styles. Separate from personal document style profiles; an empty style list says nothing about this brand.', aliases: ['saved brand company branding logo'], projection: 'dynamic', toolName: 'workspace.get_brand' },
  { id: 'document.apply_workspace_brand', parentId: 'document.styles', kind: 'tool', title: 'Apply saved workspace brand', description: 'Apply saved workspace brand fonts, heading colors, and table accents to the selected DOCX after content edits. Preserves text and verifies formatting. Does not insert a logo or company contact text. Saved document style fields take priority.', aliases: ['use saved brand company branding'], projection: 'dynamic', toolName: 'document.apply_workspace_brand' },
];

export function createWorkspaceBrandTools(input: {
  getBrand: () => Promise<WorkspaceBrandProfile | null>;
  applyBrand?: (brand: WorkspaceBrandProfile) => Promise<unknown>;
}): AgentToolSet {
  const inputSchema = jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false });
  return {
    'workspace.get_brand': defineTool({
      kind: 'read', description: workspaceBrandCapabilities[0]!.description, inputSchema,
      execute: async () => ({ brand: await input.getBrand() }),
    }),
    ...(input.applyBrand ? { 'document.apply_workspace_brand': defineTool({
      kind: 'mutate', description: workspaceBrandCapabilities[1]!.description, inputSchema,
      execute: async () => {
        const brand = await input.getBrand();
        if (!brand) throw new Error('No workspace brand is saved. Save it in Brand & Styles first.');
        return input.applyBrand!(brand);
      },
    }) } : {}),
  };
}
