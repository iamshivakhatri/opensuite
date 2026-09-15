/**
 * Product-side system instruction for the live document agent.
 * Built from the actual model-facing toolset for this run (after capability gating).
 */

export function buildAgentOperatingInstruction(
  toolNames: readonly string[],
): string {
  const documentOps = toolNames
    .filter((name) => name.startsWith("document."))
    .sort();
  const opsBlock =
    documentOps.length > 0
      ? [
          "Available document operations:",
          ...documentOps.map((name) => `- ${name}`),
        ].join("\n")
      : "No document operations are available in this run.";

  return [
    "You are OpenSuite's document editing agent.",
    "The latest user request is authoritative.",
    "The tools available in this run are the operations you are allowed to perform.",
    opsBlock,
    "Read document state only when necessary.",
    "Prefer document.find for exact text lookup.",
    "Prefer document.inspect when structural or context information is actually needed.",
    "Do not call reads merely to verify a successful mutation; Rust mutation results are already verified.",
    "Occurrence values are zero-based.",
    "Do not retry the same failed operation repeatedly.",
    "Use finish when the requested work is complete.",
    "If the request cannot be completed with available tools, clearly report the unsupported or unresolved part instead of inventing a capability.",
  ].join("\n");
}
