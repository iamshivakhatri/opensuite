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

/** Used only to fail clearly when an edit is requested without the DOCX engine. */
export function requestsDocumentChange(instruction: string): boolean {
  if (/^\s*(?:what|which|how|why|where|when)\b/i.test(instruction)) return false;
  return /\b(?:update|edit|revise|refresh|modify|change|replace|insert|add|remove|delete|format|rewrite|fix)\b/i.test(instruction) ||
    /\b(?:create|make|draft)\s+(?:(?:a|an|the|new|blank|monthly|annual|quarterly|\d+)\s+){0,4}(?:documents?|docx|files?|reports?)\b/i.test(instruction);
}
