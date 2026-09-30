/**
 * Authenticated AI Settings API helpers.
 * Secrets are sent only in PUT bodies and never stored by these helpers.
 */

import { apiFetch, parseApiError } from "./api-client";
import type {
  AiPreference,
  AiProvider,
  AiTrialStatus,
  ManagedAiModel,
  PublicProviderCredential,
} from "./ai-settings-model";

export type {
  AiPreference,
  AiProvider,
  AiTrialStatus,
  ManagedAiModel,
  PublicProviderCredential,
} from "./ai-settings-model";

export { ApiError } from "./api-client";

export async function fetchAiPreference(): Promise<AiPreference | null> {
  const response = await apiFetch("/api/ai-preferences");
  if (!response.ok) throw await parseApiError(response);
  const body = (await response.json()) as { preference: AiPreference | null };
  return body.preference;
}

export async function saveAiPreference(input: {
  readonly credentialSource: "byok" | "managed";
  readonly provider?: AiProvider;
  readonly model?: string;
}): Promise<AiPreference> {
  const response = await apiFetch("/api/ai-preferences", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseApiError(response);
  const body = (await response.json()) as { preference: AiPreference };
  return body.preference;
}

export async function listProviderCredentials(): Promise<
  PublicProviderCredential[]
> {
  const response = await apiFetch("/api/provider-credentials");
  if (!response.ok) throw await parseApiError(response);
  const body = (await response.json()) as {
    credentials: PublicProviderCredential[];
  };
  return body.credentials;
}

export async function connectProviderCredential(input: {
  readonly provider: AiProvider;
  readonly apiKey: string;
}): Promise<PublicProviderCredential> {
  const response = await apiFetch("/api/provider-credentials", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: input.provider,
      apiKey: input.apiKey,
    }),
  });
  if (!response.ok) throw await parseApiError(response);
  const body = (await response.json()) as {
    credential: PublicProviderCredential;
  };
  return body.credential;
}

export async function deleteProviderCredential(
  provider: AiProvider,
): Promise<void> {
  const response = await apiFetch(`/api/provider-credentials/${provider}`, {
    method: "DELETE",
  });
  if (!response.ok) throw await parseApiError(response);
}

export async function fetchManagedAiModels(): Promise<ManagedAiModel[]> {
  const response = await apiFetch("/api/ai-models/managed");
  if (!response.ok) throw await parseApiError(response);
  const body = (await response.json()) as { models: ManagedAiModel[] };
  return body.models;
}

export async function fetchAiTrial(): Promise<AiTrialStatus> {
  const response = await apiFetch("/api/ai-trial");
  if (!response.ok) throw await parseApiError(response);
  return (await response.json()) as AiTrialStatus;
}
