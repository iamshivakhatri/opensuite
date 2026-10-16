import { createOpenRouterModel } from "@opensuite/agent-core";
import type { ResolvedAiModel } from "../ai-preferences/resolver.js";
import type { VisionRoute } from "../agent/attachment-vision.js";

/** Fail closed when the selected model's live input modalities cannot be checked. */
export async function openRouterAcceptsImages(model: string, apiKey: string, needsTools: boolean, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  if (!/^[\w.-]+\/[\w.:-]+$/.test(model)) return false;
  try {
    const response = await fetchImpl(`https://openrouter.ai/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const { data } = await response.json() as { data?: { architecture?: { input_modalities?: string[] }; endpoints?: { status?: number; supported_parameters?: string[]; input_modalities?: string[] }[] } };
    return Array.isArray(data?.architecture?.input_modalities) && data.architecture.input_modalities.includes("image") && Array.isArray(data.endpoints) &&
      data.endpoints.some(endpoint => (endpoint.status === undefined || endpoint.status === 0) &&
        (endpoint.input_modalities === undefined || Array.isArray(endpoint.input_modalities) && endpoint.input_modalities.includes("image")) &&
        (!needsTools || Array.isArray(endpoint.supported_parameters) && endpoint.supported_parameters.includes("tools")));
  } catch { return false; }
}

/** Reader opt-in is separate for managed and BYOK; the selected key/source never changes. */
export async function resolveOpenRouterVision(input: {
  resolved: ResolvedAiModel; managedReader?: string; byokReader?: string; fetchImpl?: typeof fetch;
}): Promise<VisionRoute> {
  const { resolved } = input;
  if (resolved.provider !== "openrouter") return { direct: false };
  if (await openRouterAcceptsImages(resolved.model, resolved.apiKey, true, input.fetchImpl)) return { direct: true };
  const readerId = resolved.credentialSource === "byok" ? input.byokReader : input.managedReader;
  if (!readerId || !await openRouterAcceptsImages(readerId, resolved.apiKey, false, input.fetchImpl)) return { direct: false };
  return { direct: false, reader: { model: createOpenRouterModel({ ...resolved, model: readerId }),
    usageAttribution: { provider: resolved.provider, model: readerId, credentialSource: resolved.credentialSource } } };
}
