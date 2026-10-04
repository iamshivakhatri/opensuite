import type { StyleProfileData, WorkspaceBrandProfile } from '@opensuite/contracts';
import {
  buildStyleApplicationPlan,
  styleApplicationFields,
  type RoleFormatting,
  type StyleApplicationPlan,
} from '../style-profiles/application.js';

export type BrandChannel = 'typography' | 'colors' | 'tableAccent';
export type DocumentBrandPolicy = { readonly channels: readonly BrandChannel[] };
export type AppearanceSource = 'saved_style' | 'workspace_brand';

export interface ResolvedAppearance {
  readonly plan: StyleApplicationPlan;
  readonly provenance: Readonly<Record<string, AppearanceSource>>;
}

const emptyPlan = (): StyleApplicationPlan => ({ roles: {}, page: {}, unsupported: [] });
const role = (plan: StyleApplicationPlan, name: string): RoleFormatting =>
  plan.roles[name] ??= { text: {}, paragraph: {} };
const hex = (value: string | null) => value?.slice(1).toUpperCase();

/** Resolve only deterministic, supported appearance facts. Content identity is deliberately excluded. */
export function resolveDocumentAppearance(input: {
  readonly savedStyle?: StyleProfileData;
  readonly workspaceBrand?: WorkspaceBrandProfile | null;
  readonly policy: DocumentBrandPolicy;
  readonly brand?: 'auto' | 'off';
}): ResolvedAppearance {
  const plan = input.savedStyle ? buildStyleApplicationPlan(input.savedStyle) : emptyPlan();
  const provenance: Record<string, AppearanceSource> = Object.fromEntries(
    styleApplicationFields(plan).map((field) => [field, 'saved_style']),
  );
  if (input.brand === 'off' || !input.workspaceBrand) return { plan, provenance };

  const allowed = new Set(input.policy.channels);
  const set = (field: string, key: string, value: string | undefined, target: Record<string, unknown>) => {
    if (value === undefined || target[key] !== undefined) return;
    target[key] = value;
    provenance[field] = 'workspace_brand';
  };
  if (allowed.has('typography')) {
    const heading = input.workspaceBrand.typography.headingFont || undefined;
    const body = input.workspaceBrand.typography.bodyFont || undefined;
    set('body.text.fontFamily', 'fontFamily', body, role(plan, 'body').text);
    for (const name of ['Title', 'Heading1', 'Heading2', 'Heading3']) {
      set(`${name}.text.fontFamily`, 'fontFamily', heading, role(plan, name).text);
    }
  }
  if (allowed.has('colors')) {
    set('Title.text.color', 'color', hex(input.workspaceBrand.colors.primary), role(plan, 'Title').text);
    set('Heading1.text.color', 'color', hex(input.workspaceBrand.colors.primary), role(plan, 'Heading1').text);
    set('Heading2.text.color', 'color', hex(input.workspaceBrand.colors.secondary), role(plan, 'Heading2').text);
    set('Heading3.text.color', 'color', hex(input.workspaceBrand.colors.accent), role(plan, 'Heading3').text);
  }
  if (allowed.has('tableAccent')) {
    plan.table ??= { formatting: {} };
    set('table.headerFill', 'headerFill', hex(input.workspaceBrand.colors.accent) ?? hex(input.workspaceBrand.colors.primary), plan.table as Record<string, unknown>);
  }
  return { plan, provenance };
}

/** Small explicit opt-out; this deliberately does not attempt to classify general language. */
export function requestsNoWorkspaceBrand(instruction: string): boolean {
  return /\b(?:do not|don't|without|no)\s+(?:(?:use|apply|include)\s+)?(?:our\s+|the\s+)?(?:(?:company|workspace)\s+)?brand(?:ing)?\b/i.test(instruction);
}

export function shouldApplyAutomaticBrand(input: {
  readonly isNewDocument: boolean;
  readonly policy: DocumentBrandPolicy | undefined;
  readonly instruction: string;
}): input is { readonly isNewDocument: true; readonly policy: DocumentBrandPolicy; readonly instruction: string } {
  return input.isNewDocument && !!input.policy?.channels.length && !requestsNoWorkspaceBrand(input.instruction);
}
