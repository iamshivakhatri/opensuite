import type { DocumentSkillDefinition } from './policy.js';

export const reportingSkills: DocumentSkillDefinition[] = [
  {
    id: "skills.reporting.analytical-report", parentId: "skills.reporting", kind: "instruction",
    title: "Analytical Report", description: "Create a grounded business, operating, quarterly, KPI, or metrics report from supplied facts and sources",
    aliases: ["monthly operating report", "quarterly operating report", "KPI report", "metrics report", "business analysis report", "professional report"], projection: "dynamic",
    brandPolicy: { channels: ['typography', 'colors', 'tableAccent', 'logo'] },
    instructions: () => `Build a report around the user's purpose and supplied evidence.
- Give it a clear title and a short executive summary when the audience or length warrants one.
- Use a logical section hierarchy; adapt sections to the task instead of forcing a fixed outline.
- Separate reported facts from interpretation, and label uncertainty.
- Use a table when supplied structured data becomes easier to compare or check.
- End with concise conclusions or next steps when supported.
- Never invent missing metrics, causes, dates, or sources.`,
  },
  {
    id: "skills.reporting.recurring-update", parentId: "skills.reporting", kind: "instruction",
    title: "Recurring Report Update", description: "Update an existing periodic report using new evidence while preserving unchanged content",
    aliases: ["monthly report figures update", "weekly quarterly report refresh", "reconcile new figures"], projection: "dynamic",
    brandPolicy: { channels: [] },
    instructions: () => `Update the existing report conservatively.
- Identify what the new information actually changes; edit only affected sections.
- Preserve prior facts and unrelated content unless newer evidence replaces or contradicts them.
- Reconcile totals against detailed rows only when the operands are exact and supported.
- Flag unresolved contradictions instead of silently changing or rebasing numbers.
- Prefer narrow edits over rebuilding the document. Keep its current structure and style unless redesign is requested.
- Do not invent missing period results, explanations, or comparisons.`,
  },
];
