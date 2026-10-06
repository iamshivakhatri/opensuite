import type { DocumentSkillDefinition } from './policy.js';

export const coordinationSkills: DocumentSkillDefinition[] = [{
  id: "skills.coordination.meeting-minutes", parentId: "skills.coordination", kind: "instruction",
  title: "Meeting Minutes", description: "Turn supplied notes or a transcript into clear meeting minutes",
  aliases: ["meeting notes decisions actions"], projection: "dynamic",
  brandPolicy: { channels: ['typography'] },
  instructions: () => `Turn the supplied meeting record into concise minutes.
- State the meeting purpose and context when known, then summarize discussion by topic.
- Separate decisions from proposals and unresolved questions.
- List actions with owners and deadlines only when the source supplies them.
- Preserve material uncertainty or disagreement rather than implying consensus.
- Never invent attendees, owners, deadlines, or decisions.`,
}];
