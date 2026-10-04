import type { CapabilityDefinition } from "../../core/registry.js";

export const procedureSkills: CapabilityDefinition[] = [{
  id: "skills.procedures.sop", parentId: "skills.procedures", kind: "instruction",
  title: "SOP", description: "Create or conservatively update a clear process or SOP document",
  aliases: ["SOP process procedure steps"], projection: "dynamic",
  instructions: () => `Create or update a basic standard operating procedure from supplied process facts.
- State purpose, scope, and responsibilities where known; add prerequisites or definitions only when useful.
- Write numbered, imperative steps in the order work is actually performed.
- Include exceptions, warnings, records, and references only when supplied.
- Keep an existing SOP's unchanged instructions intact during an update.
- Never invent compliance requirements or claim regulatory approval without supporting sources.`,
}];
