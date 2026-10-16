import { jsonSchema } from 'ai';
import { defineTool, type AgentToolSet } from '@opensuite/agent-core';
import type { WorkspaceBrandProfile } from '@opensuite/contracts';
import type { CapabilityDefinition } from '../core/registry.js';

export const workspaceBrandCapabilities: CapabilityDefinition[] = [
  { id: 'workspace.get_brand', parentId: 'workspace', kind: 'tool', title: 'Read saved workspace brand', description: 'Read the company identity, colors, fonts, and logo ID saved in Brand & Styles. Separate from personal document style profiles; an empty style list says nothing about this brand.', aliases: ['saved brand company branding logo'], projection: 'dynamic', toolName: 'workspace.get_brand' },
  { id: 'document.apply_workspace_brand', parentId: 'document.styles', kind: 'tool', title: 'Apply saved workspace brand', description: 'Apply saved workspace brand fonts, heading colors, table accents, and its logo to the selected DOCX after content edits. Includes the saved logo by default as a small mark, at most 1.5 inches wide and 0.5 inches tall, preserving aspect ratio. Set includeLogo=false to omit it. Preserves text and verifies formatting; does not invent contact text. Saved document style fields take priority.', aliases: ['use saved brand company branding add logo'], projection: 'dynamic', toolName: 'document.apply_workspace_brand' },
];

export function createWorkspaceBrandTools(input: {
  getBrand: () => Promise<WorkspaceBrandProfile | null>;
  applyBrand?: (brand: WorkspaceBrandProfile, includeLogo: boolean) => Promise<unknown>;
}): AgentToolSet {
  const inputSchema = jsonSchema<Record<string, never>>({ type: 'object', properties: {}, additionalProperties: false });
  return {
    'workspace.get_brand': defineTool({
      kind: 'read', description: workspaceBrandCapabilities[0]!.description, inputSchema,
      execute: async () => ({ brand: await input.getBrand() }),
    }),
    ...(input.applyBrand ? { 'document.apply_workspace_brand': defineTool({
      kind: 'mutate', description: workspaceBrandCapabilities[1]!.description,
      inputSchema: jsonSchema<{ includeLogo?: boolean }>({ type: 'object', properties: { includeLogo: { type: 'boolean', description: 'Include the saved logo as a small brand mark (default true).' } }, additionalProperties: false }),
      execute: async ({ includeLogo = true }) => {
        const brand = await input.getBrand();
        if (!brand) throw new Error('No workspace brand is saved. Save it in Brand & Styles first.');
        return input.applyBrand!(brand, includeLogo);
      },
    }) } : {}),
  };
}
