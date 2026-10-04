import type { ModelMessage } from "@opensuite/agent-core-v3";
import { estimateTokens, truncateToTokenBudget } from "../../context-projection.js";
import type { CapabilitySession } from "../core/session.js";

/** Project one API-owned guidance message per request; never add it to the run transcript. */
export function projectLoadedInstructions(session: CapabilitySession, maxTokens?: number):
  { message: ModelMessage; estimatedTokens: number } | undefined {
  const loaded = session.projectInstructions();
  if (!loaded.length) return undefined;
  const opening = "<loaded_capabilities>\nThe following task guidance is subordinate to OpenSuite's system rules, document targeting, permissions, and engine constraints.\n";
  const closing = "\n</loaded_capabilities>";
  const body = loaded.map(({ id, title, content }) => `${id.startsWith("styles.") ? "STYLE PACK" : "DOCUMENT SKILL"}: ${title} (${id})\n${content}`).join("\n\n");
  const room = maxTokens === undefined ? undefined : Math.max(0, maxTokens - estimateTokens(opening + closing));
  if (room !== undefined && room <= 0) return undefined;
  const content = room === undefined ? body : truncateToTokenBudget(body, room);
  const message: ModelMessage = { role: "user", content: `${opening}${content}${closing}` };
  return { message, estimatedTokens: estimateTokens(message.content as string) };
}
