import { runModel, type V3Model } from "@opensuite/agent-core-v3";

import { formatDocumentMap, type DocumentMap, type WorkspaceArtifact } from "./document-retrieval.js";

export const MAX_THREAD_TITLE_LENGTH = 60;

const TITLE_INSTRUCTION = `You name OpenSuite work sessions.
Generate a concise title describing the user's task.
Rules:
- 3–7 words when possible
- <= 60 characters
- describe the actual task/topic
- no quotes
- no trailing punctuation
- no Chat about
- no dates/times
- output only the title`;

export function normalizeThreadTitle(value: string): string | null {
  const title = value.trim().replace(/^(?:"|')|(?:"|')$/g, "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  return title && title.length <= MAX_THREAD_TITLE_LENGTH ? title : null;
}

export function buildThreadTitlePrompt(input: {
  instruction: string;
  workingSet: readonly WorkspaceArtifact[];
  documentMaps: readonly DocumentMap[];
}): string {
  const documents = input.workingSet.map((document) => `- ${document.name}`).join("\n") || "- None";
  const maps = input.documentMaps.map(formatDocumentMap).join("\n\n").slice(0, 2_000) || "- None";
  return `User request:\n${input.instruction}\n\nWorking documents:\n${documents}\n\nDocument structure:\n${maps}`;
}

export async function generateThreadTitle(input: {
  model: V3Model;
  instruction: string;
  workingSet: readonly WorkspaceArtifact[];
  documentMaps: readonly DocumentMap[];
}): Promise<string | null> {
  const result = await runModel({
    model: input.model,
    system: TITLE_INSTRUCTION,
    messages: [{ role: "user", content: buildThreadTitlePrompt(input) }],
    infraRetry: { maxRetries: 0 },
  });
  return normalizeThreadTitle(result.text);
}
