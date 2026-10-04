import type { CapabilityDefinition } from "../../core/registry.js";

export const proposalSkills: CapabilityDefinition[] = [{
  id: "skills.proposals.basic-proposal", parentId: "skills.proposals", kind: "instruction",
  title: "Basic Proposal", description: "Draft a grounded ordinary business or project proposal",
  aliases: ["project proposal business proposal"], projection: "dynamic",
  instructions: () => `Draft an ordinary business or project proposal, adapting the outline to the request.
- Explain the client need, problem, and context from supplied material.
- Describe the proposed approach, scope, deliverables, and assumptions clearly.
- Include a timeline or pricing only when supplied or explicitly supported.
- End with concrete next steps; persuade through evidence rather than invented claims.
- Identify required missing information instead of fabricating it.
- Do not imply legal, procurement, tender, or contract terms that were not supplied.`,
}];
