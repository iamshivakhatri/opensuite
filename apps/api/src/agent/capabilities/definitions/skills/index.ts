import { scientificPaperCapability } from "./scientific-paper.js";
import { reportingSkills } from "./reporting.js";
import { coordinationSkills } from "./coordination.js";
import { correspondenceSkills } from "./correspondence.js";
import { proposalSkills } from "./proposals.js";
import { careerSkills } from "./career.js";
import { procedureSkills } from "./procedures.js";

export const documentSkills = [
  scientificPaperCapability,
  ...reportingSkills,
  ...coordinationSkills,
  ...correspondenceSkills,
  ...proposalSkills,
  ...careerSkills,
  ...procedureSkills,
];
