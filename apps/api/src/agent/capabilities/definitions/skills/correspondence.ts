import type { DocumentSkillDefinition } from './policy.js';

export const correspondenceSkills: DocumentSkillDefinition[] = [
  {
    id: "skills.correspondence.executive-memo", parentId: "skills.correspondence", kind: "instruction",
    title: "Executive Memo", description: "Write a short audience-aware business memo or decision brief",
    aliases: ["executive brief decision memo"], projection: "dynamic",
    brandPolicy: { channels: ['typography', 'colors'] },
    instructions: () => `Write a concise memo for the intended audience.
- Put the bottom line first, followed by only the context needed to understand it.
- State the recommendation or decision clearly when the evidence supports one.
- Distinguish facts from assumptions and unresolved risks.
- Use short sections only when they help the reader; avoid padding.`,
  },
  {
    id: "skills.correspondence.professional-letter", parentId: "skills.correspondence", kind: "instruction",
    title: "Professional Letter", description: "Write grounded client or business correspondence",
    aliases: ["business letter client correspondence"], projection: "dynamic",
    brandPolicy: { channels: ['typography', 'colors'] },
    instructions: () => `Write a professional letter suited to the user's audience and intent.
- Use an appropriate greeting, opening, concise body, and closing.
- Match the requested level of formality without sounding formulaic.
- Keep claims grounded in supplied facts and make the requested action clear.
- Never invent names, addresses, dates, commitments, or other details.`,
  },
];
