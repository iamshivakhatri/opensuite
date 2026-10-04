import type {
  WorkspaceBrandData,
  WorkspaceBrandProfile,
  StyleProfile,
  StyleProfileSummary,
} from "@opensuite/contracts";
import { apiFetch, parseApiError } from "./api-client";

export type { WorkspaceBrandData, WorkspaceBrandProfile, StyleProfile };
export function emptyBrand(): WorkspaceBrandData {
  return {
    schemaVersion: 1,
    organization: { name: "", website: "", email: "", phone: "", address: "" },
    logoAssetId: null,
    colors: { primary: null, secondary: null, accent: null },
    typography: { headingFont: "", bodyFont: "" },
    document: {
      headerText: "",
      footerText: "",
      showLogo: true,
      showOrganizationName: true,
      showPageNumbers: true,
    },
  };
}
export function brandData(profile: WorkspaceBrandProfile): WorkspaceBrandData {
  const { workspaceId: _workspace, createdAt: _created, updatedAt: _updated, ...data } = profile;
  return data;
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await parseApiError(response);
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}
const brandPath = (workspaceId: string) => `/api/workspaces/${workspaceId}/brand`;
const assetPath = (workspaceId: string, id?: string) =>
  `/api/workspaces/${workspaceId}/assets${id ? `/${id}` : ""}`;
export async function fetchBrand(workspaceId: string) {
  return (await request<{ profile: WorkspaceBrandProfile | null }>(brandPath(workspaceId))).profile;
}
export async function saveBrand(workspaceId: string, data: WorkspaceBrandData) {
  return (
    await request<{ profile: WorkspaceBrandProfile }>(brandPath(workspaceId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    })
  ).profile;
}
export async function uploadBrandImage(workspaceId: string, file: File) {
  const body = new FormData();
  body.append("file", file);
  return (
    await request<{ asset: { id: string } }>(assetPath(workspaceId), {
      method: "POST",
      body,
    })
  ).asset.id;
}
export async function fetchBrandImage(workspaceId: string, id: string) {
  const response = await apiFetch(assetPath(workspaceId, id));
  if (!response.ok) throw await parseApiError(response);
  return response.blob();
}
export function removeUnusedImage(workspaceId: string, id: string) {
  return request<void>(assetPath(workspaceId, id), { method: "DELETE" });
}
// Saved styles remain personal profiles; these calls reuse the Phase 2 API.
export async function listSavedStyles(offset = 0) {
  return (
    await request<{ profiles: StyleProfileSummary[] }>(
      `/api/style-profiles?limit=20&offset=${offset}`,
    )
  ).profiles;
}
export async function getSavedStyle(id: string) {
  return (await request<{ profile: StyleProfile }>(`/api/style-profiles/${id}`)).profile;
}
export async function renameSavedStyle(id: string, name: string) {
  return (
    await request<{ profile: StyleProfile }>(`/api/style-profiles/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    })
  ).profile;
}
export function deleteSavedStyle(id: string) {
  return request<void>(`/api/style-profiles/${id}`, { method: "DELETE" });
}
