"use client";
import * as React from "react";
import {
  brandData,
  emptyBrand,
  fetchBrand,
  fetchBrandImage,
  saveBrand,
  uploadBrandImage,
  removeUnusedImage,
  type WorkspaceBrandData,
} from "@/lib/brand-api";
import { useToast } from "@/lib/toast";
import { userFacingError } from "@/components/files/format";

export function useBrand(workspaceId: string) {
  const { toast } = useToast();
  const [data, setData] = React.useState<WorkspaceBrandData>(emptyBrand);
  const [saved, setSaved] = React.useState<WorkspaceBrandData>(emptyBrand);
  const [logoFile, setLogoFile] = React.useState<File | null>(null);
  const [logoUrl, setLogoUrl] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const dirty = Boolean(logoFile) || JSON.stringify(data) !== JSON.stringify(saved);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoadFailed(false);
    setLogoFile(null);
    void fetchBrand(workspaceId)
      .then((profile) => {
        if (cancelled) return;
        const next = profile ? brandData(profile) : emptyBrand();
        setData(next);
        setSaved(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadFailed(true);
          setError(userFacingError(err, "Could not load brand settings."));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, reload]);

  React.useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setLogoUrl(null);
    const image = logoFile
      ? Promise.resolve(logoFile)
      : data.logoAssetId
        ? fetchBrandImage(workspaceId, data.logoAssetId)
        : null;
    if (image)
      void image
        .then((blob) => {
          if (!cancelled) {
            url = URL.createObjectURL(blob);
            setLogoUrl(url);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(userFacingError(err, "Could not load logo."));
        });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [workspaceId, logoFile, data.logoAssetId]);

  React.useEffect(() => {
    if (!dirty && !busy) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, busy]);

  function chooseLogo(file: File) {
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Use a PNG, JPEG, or WebP image up to 2 MB.");
      return;
    }
    setError(null);
    setLogoFile(file);
  }
  async function save() {
    if (busy || loading || loadFailed) return;
    setBusy(true);
    setError(null);
    let uploaded: string | null = null;
    try {
      if (logoFile) uploaded = await uploadBrandImage(workspaceId, logoFile);
      const profile = await saveBrand(workspaceId, {
        ...data,
        logoAssetId: uploaded ?? data.logoAssetId,
      });
      uploaded = null;
      const next = brandData(profile);
      setData(next);
      setSaved(next);
      setLogoFile(null);
      toast({ tone: "success", title: "Brand settings saved" });
    } catch (err) {
      setError(userFacingError(err, "Could not save brand settings."));
      if (uploaded) await removeUnusedImage(workspaceId, uploaded).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  return {
    data,
    setData,
    logoUrl,
    loading,
    loadFailed,
    busy,
    dirty,
    error,
    chooseLogo,
    save,
    retry: () => setReload((value) => value + 1),
    removeLogo: () => {
      setLogoFile(null);
      setData((current) => ({ ...current, logoAssetId: null }));
    },
  };
}
