import type { DocumentBrandPolicy } from '../../../../document-appearance/resolve.js';
import type { CapabilityDefinition } from '../../core/registry.js';

export type DocumentSkillDefinition = Extract<CapabilityDefinition, { kind: 'instruction' }> & {
  readonly brandPolicy: DocumentBrandPolicy;
};
