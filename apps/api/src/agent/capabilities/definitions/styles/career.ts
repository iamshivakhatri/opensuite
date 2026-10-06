import type { CapabilityDefinition } from "../../core/registry.js";

export const careerStyles: CapabilityDefinition[] = [{
  id: "styles.career.clean-resume", parentId: "styles.career", kind: "instruction",
  title: "Clean Resume Style", description: "Readable one-column résumé or CV appearance",
  aliases: ["clean professional resume work history curriculum vitae style"], projection: "dynamic",
  companionCapabilities: ["document.paragraphs", "document.text"],
  instructions: () => `Keep a résumé clean, compact, and readable in DOCX and PDF.
- In a new blank document, set the name to the guaranteed Title paragraph style. Keep the target role and contact line as Normal, using document.set_text_formatting only for restrained emphasis.
- Set section headings to the guaranteed Heading 1 or Heading 2 style. Keep employer, title, and date lines as Normal; use direct bold or italic text formatting when useful.
- Turn accomplishment paragraphs into true bullets with document.set_paragraphs_list using kind \"bullet\". Never imitate bullets with a paragraph style or bullet characters.
- Use document.set_paragraph_formatting or its batch form for compact spacing and simple indentation.
- Keep a factual one-column reading order. Avoid unsupported layout tricks and invented paragraph styles such as List Bullet or Resume Bullet.
- Preserve any user-supplied template requirements.`,
}];
