/** Loaded only when this skill is requested; catalog metadata stays small. */
export function scientificPaperInstructions(): string {
  return `Draft scientific papers in clear, concise professional language.
- Use a conventional structure (abstract, introduction, methods, results, discussion, conclusion) when it fits the requested paper. Adapt or omit sections as the user requests.
- Separate supplied evidence from your own interpretation. Label uncertainty and inference clearly.
- Never invent methods, experimental results, measurements, or citations. Preserve supplied numbers and units exactly.
- State what information is missing when a requested claim or section cannot be supported. Use available sources and tools when evidence is needed.
- Keep claims proportional to the evidence and preserve the user's intended scope.`;
}
