import type { CapabilityDefinition } from "../../core/registry.js";

export const correspondenceStyles: CapabilityDefinition[] = [{
  id: "styles.correspondence.executive", parentId: "styles.correspondence", kind: "instruction",
  title: "Executive Correspondence Style", description: "Compact, restrained appearance for memos and business letters",
  aliases: ["executive memo decision brief style", "professional client letter"], projection: "dynamic",
  companionCapabilities: ["document.text", "document.paragraphs", "document.layout"],
  instructions: () => `Give a memo or letter a compact professional appearance.
- In a new blank document, use the guaranteed Title style for a title and Heading 1 or Heading 2 only when real sections are needed. Keep ordinary lines as Normal.
- Keep body paragraphs readable, left aligned, and consistently spaced with document.set_paragraph_formatting.
- Use document.set_text_formatting for sparse bold or italic emphasis; do not invent paragraph styles.
- Add a simple header or footer through document.set_header_footer_text only when it serves the document and that capability is available.
- Respect any supplied letterhead, template, or formatting directions.`,
}];
