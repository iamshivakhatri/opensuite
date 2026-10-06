import type { DocumentSkillDefinition } from './policy.js';

export const careerSkills: DocumentSkillDefinition[] = [{
  id: "skills.career.resume", parentId: "skills.career", kind: "instruction",
  title: "Resume", description: "Create or improve a factual résumé or CV from work history",
  aliases: ["clean professional resume work history curriculum vitae job application"], projection: "dynamic",
  brandPolicy: { channels: [] },
  instructions: () => `Create a readable résumé or CV from the person's supplied record.
- Use a concise professional summary when it helps, then experience, education, and relevant skills.
- Write accomplishment-oriented bullets without turning duties into invented achievements.
- Preserve factual employers, titles, dates, degrees, skills, and metrics exactly.
- Tailor emphasis to a supplied job description when available.
- Never invent employment, education, certifications, results, or contact details.`,
}];
