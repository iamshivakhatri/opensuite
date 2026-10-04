/** Only an explicit edit or style-learning reference binds the open file before the model acts. */
export function refersToOpenDocument(instruction: string): boolean {
  if (/\b(?:learn|save)\s+(?:the\s+)?style\s+(?:from|of)\s+(?:the\s+)?(?:this|current|open)\s+(?:document|doc|file|report)\b/i.test(instruction)) return true;
  return /\b(?:update|edit|revise|refresh|modify|change|format|rewrite|fix)\s+(?:the\s+)?(?:this|current|open)\s+(?:document|doc|file|report)\b/i.test(instruction);
}

/** Used only to fail clearly when an edit is requested without the DOCX engine. */
export function requestsDocumentChange(instruction: string): boolean {
  if (/^\s*(?:what|which|how|why|where|when)\b/i.test(instruction)) return false;
  return /\b(?:update|edit|revise|refresh|modify|change|replace|insert|add|remove|delete|format|rewrite|fix)\b/i.test(instruction) ||
    /\b(?:create|make|draft)\s+(?:(?:a|an|the|new|blank|monthly|annual|quarterly|\d+)\s+){0,4}(?:documents?|docx|files?|reports?)\b/i.test(instruction);
}
