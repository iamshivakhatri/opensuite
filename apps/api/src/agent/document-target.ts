const OPEN_DOCUMENT = String.raw`(?:the\s+)?(?:this|current|open|opened)\s+(?:document|doc|docx|file|report)\b`;
const EDIT_VERB = String.raw`\b(?:update|edit|revise|refresh|modify|change|format|reformat|rewrite|fix|correct|proofread|polish|improve|tighten|shorten|expand|add|insert|append|prepend|remove|delete|replace|rename|retitle|move|bold|italici[sz]e|underline|shade|highlight|restyle|number|clean\s+up)\b`;
/** "from/using/based on this document" makes the open file a source, not the target. */
const SOURCE_PHRASE = String.raw`(?<!\b(?:from|using|use|like|than|with|as|per|based\s+on|according\s+to|compared?\s+to)\s+(?:the\s+)?)`;
const EDIT_THEN_OPEN = new RegExp(`${EDIT_VERB}[^.?!\\n]{0,160}?\\s${SOURCE_PHRASE}${OPEN_DOCUMENT}`, "i");
const REMOVE_FROM_OPEN = new RegExp(`\\b(?:remove|delete|strip|drop)\\b[^.?!\\n]{0,160}?\\bfrom\\s+${OPEN_DOCUMENT}`, "i");
const IN_OPEN_THEN_EDIT = new RegExp(`\\b(?:in|on|within|throughout)\\s+${OPEN_DOCUMENT}[^.?!\\n]{0,160}?${EDIT_VERB}`, "i");

/** Only an explicit edit or style-learning reference binds the open file before the model acts. */
export function refersToOpenDocument(instruction: string): boolean {
  if (/\b(?:learn|save)\s+(?:the\s+)?(?:document\s+)?style\s+(?:from|of)\s+(?:the\s+)?(?:this|current|open)\s+(?:document|doc|file|report)\b/i.test(instruction)) return true;
  if (/\b(?:apply|use)\b[^.\n]{0,160}\bstyle\b[^.\n]{0,30}\b(?:to|on)\s+(?:the\s+)?(?:this|current|open)\s+(?:document|doc|file|report)\b/i.test(instruction)) return true;
  return [EDIT_THEN_OPEN, REMOVE_FROM_OPEN, IN_OPEN_THEN_EDIT].some((pattern) => pattern.test(` ${instruction}`));
}

/** Recognize edit requests without choosing a document from reference evidence. */
export function requestsDocumentChange(instruction: string): boolean {
  if (/^\s*(?:what|which|how|why|where|when)\b/i.test(instruction)) return false;
  return new RegExp(EDIT_VERB, "i").test(instruction) ||
    requestsNewDocument(instruction);
}

/** Creation never uses an existing document as the edit target. */
export function requestsNewDocument(instruction: string): boolean {
  return /\b(?:create|make|start|draft)\s+(?:(?:a|an|the|brand|new|blank|monthly|annual|quarterly|\d+)\s+){0,5}(?:documents?|docx|files?|reports?|newsletters?|letters?|proposals?|resumes?)\b/i.test(instruction) ||
    /\b(?:create|make|start|draft)\s+(?:a\s+|an\s+|the\s+)?(?:brand\s+)?new\b/i.test(instruction);
}

/** Exact target wording wins; relevance scores and reference-only tags never select. */
export function resolveDocumentTarget(input: {
  instruction: string;
  openDocumentId: string | null;
  documentIds: readonly string[];
  documents: readonly { id: string; name: string; format: string }[];
}): string | null {
  if (requestsNewDocument(input.instruction)) return null;
  if (refersToOpenDocument(input.instruction)) return input.openDocumentId;
  if (!requestsDocumentChange(input.instruction)) return null;
  const editRequest = input.instruction.split(/\b(?:from|using|based on|according to|with data|as (?:a )?reference)\b/i)[0]!;
  const mentioned = input.documents.filter((document) => {
    const title = document.name.replace(/\.docx$/i, "").toLowerCase();
    return title && editRequest.toLowerCase().includes(title);
  });
  if (mentioned.length > 1) return null;
  const targets = mentioned.filter((document) => {
    const title = document.name.replace(/\.docx$/i, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!title) return false;
    const name = `(?:["“']?${title}(?:\\.docx)?["”']?)(?![\\p{L}\\p{N}_])`;
    return new RegExp(`${EDIT_VERB}\\s+(?:the\\s+)?${name}`, "iu").test(editRequest) ||
      new RegExp(`\\b(?:in|on|within|to|of)\\s+(?:the\\s+)?${name}[^.?!\\n]{0,160}?${EDIT_VERB}|${EDIT_VERB}[^.?!\\n]{0,160}?\\b(?:in|on|within|to|of)\\s+(?:the\\s+)?${name}`, "iu").test(editRequest);
  });
  if (targets.length) return targets.length === 1 && targets[0]!.format === "docx" ? targets[0]!.id : null;
  // A tag alone may be a source. Bind only when the request supplies no source or other target wording.
  if (/\b(?:from(?!\s+["“']?\d)|using|based on|according to|references?|sources?|other|another|all|across)\b/i.test(input.instruction) ||
      input.documents.some((document) => input.instruction.toLowerCase().includes(document.name.replace(/\.docx$/i, "").toLowerCase()))) return null;
  if (!/\b(?:attached|tagged)\s+(?:document|file|report)\b/i.test(input.instruction) &&
      !/\b(?:table|row|column|cell|paragraph|section|heading|header|footer|value|text|typos?|formatting)\b/i.test(input.instruction)) return null;
  const ids = [...new Set(input.documentIds)];
  return ids.length === 1 ? ids[0]! : ids.length === 0 ? input.openDocumentId : null;
}
