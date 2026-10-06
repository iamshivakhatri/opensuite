import { scientificPaperCapability } from "./scientific-paper.js";
import { reportingSkills } from "./reporting.js";
import { coordinationSkills } from "./coordination.js";
import { correspondenceSkills } from "./correspondence.js";
import { proposalSkills } from "./proposals.js";
import { careerSkills } from "./career.js";
import { procedureSkills } from "./procedures.js";
import type { DocumentSkillDefinition } from './policy.js';

export const documentSkills: DocumentSkillDefinition[] = [
  scientificPaperCapability,
  ...reportingSkills,
  ...coordinationSkills,
  ...correspondenceSkills,
  ...proposalSkills,
  ...careerSkills,
  ...procedureSkills,
];

export function documentSkillPolicy(id: string) {
  return documentSkills.find((skill) => skill.id === id)?.brandPolicy;
}
