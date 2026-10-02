import { jsonSchema } from "ai";
import { defineTool } from "@opensuite/agent-core-v3";
import type { DocxEngineBinding } from "@opensuite/engine-client";

import type { DocumentService } from "../documents/service.js";

const MAX_RESULTS = 8;
const MAX_QUERY_LENGTH = 120;

type SearchDocuments = Pick<DocumentService, "listInWorkspace" | "readExactVersionBytes">;

/** Search the owner's workspace; matching a document never adds it to the working set. */
export async function searchWorkspaceDocuments(input: {
  documents: SearchDocuments;
  binding?: DocxEngineBinding;
  ownerUserId: string;
  workspaceId: string;
  query: string;
}) {
  const query = input.query.trim();
  if (query.length < 2 || query.length > MAX_QUERY_LENGTH) {
    return { ok: false, reasonCode: "INVALID_QUERY", message: "Use a search phrase of 2–120 characters." };
  }

  const documents = await input.documents.listInWorkspace(input.workspaceId, input.ownerUserId);
  const lowerQuery = query.toLowerCase();
  const words = lowerQuery.match(/[\p{L}\p{N}]+/gu) ?? [];
  const matches: Array<{ documentId: string; name: string; format: string; reason: string; snippet?: string; score: number }> = [];
  let skippedDocuments = 0;

  // ponytail: scans current DOCX versions per query; add a text index if workspace size makes this slow.
  for (let offset = 0; offset < documents.length; offset += 4) {
    await Promise.all(documents.slice(offset, offset + 4).map(async (document) => {
      const name = document.name.toLowerCase();
      const nameWords = new Set(name.replace(/\.[^.]+$/, "").match(/[\p{L}\p{N}]+/gu) ?? []);
      const nameScore = name.includes(lowerQuery) ? 3
        : words.length && words.every((word) => nameWords.has(word)) ? 2
        : words.some((word) => nameWords.has(word)) ? 1 : 0;
      const formatMatch = document.format.toLowerCase() === lowerQuery;
      let snippet: string | undefined;
      if (document.format === "docx" && input.binding) {
        try {
          const bytes = await input.documents.readExactVersionBytes({
            documentId: document.id, versionId: document.latestVersion.id, ownerUserId: input.ownerUserId,
          });
          const found = await input.binding.findDocxText(new Uint8Array(bytes), { text: query });
          if (found.ok && found.matches[0]) {
            const match = found.matches[0];
            snippet = `${match.before}${match.text}${match.after}`.replace(/\s+/g, " ").trim().slice(0, 120);
          } else if (!found.ok) skippedDocuments++;
        } catch {
          skippedDocuments++;
        }
      }
      if (!nameScore && !formatMatch && !snippet) return;
      matches.push({ documentId: document.id, name: document.name, format: document.format,
        reason: nameScore ? snippet ? "name and text" : "name" : snippet ? "text" : "format",
        ...(snippet ? { snippet } : {}), score: nameScore * 2 + Number(Boolean(snippet)) + Number(formatMatch) });
    }));
  }
  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.documentId.localeCompare(b.documentId));
  return { ok: true, query, matchCount: matches.length, skippedDocuments, textSearchAvailable: Boolean(input.binding),
    matches: matches.slice(0, MAX_RESULTS).map(({ score: _score, ...match }) => match) };
}

export function createWorkspaceSearchTool(input: Omit<Parameters<typeof searchWorkspaceDocuments>[0], "query">) {
  return defineTool<{ query: string }, Awaited<ReturnType<typeof searchWorkspaceDocuments>>>({
    kind: "read",
    description: "Search names and exact text across the current workspace, including documents outside the working set. Returns up to 8 compact matches with IDs. Search does not make documents editable; use workspace_inspect_document for a narrow DOCX read. Use a short phrase and search again if needed.",
    inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string", minLength: 2, maxLength: MAX_QUERY_LENGTH } }, required: ["query"], additionalProperties: false }),
    execute: ({ query }) => searchWorkspaceDocuments({ ...input, query }),
  });
}
