"use client";

import * as React from "react";

import { Dialog } from "@/components/ui/dialog";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

/**
 * Object URL for a local file or an authorized attachment fetch. The URL is
 * revoked when the source changes or the component unmounts.
 */
function useImageUrl(
  file: File | undefined,
  attachmentId: string | undefined,
  load: ((attachmentId: string) => Promise<Blob>) | undefined,
) {
  const [state, setState] = React.useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  });
  const loadRef = React.useRef(load);
  loadRef.current = load;

  React.useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setState({ url: null, failed: false });
    if (file) {
      url = URL.createObjectURL(file);
      setState({ url, failed: false });
    } else if (attachmentId && loadRef.current) {
      loadRef
        .current(attachmentId)
        .then((blob) => {
          if (cancelled) return;
          url = URL.createObjectURL(blob);
          setState({ url, failed: false });
        })
        .catch(() => {
          if (!cancelled) setState({ url: null, failed: true });
        });
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [file, attachmentId]);

  return state;
}

/**
 * Compact rounded-square image thumbnail that opens a simple full-size preview.
 * Pass `file` for a pre-send upload (no download) or `attachmentId` + `load` for
 * a sent message. `children` render over the thumbnail (status / remove controls).
 */
export function ImageAttachmentThumb({
  name,
  file,
  attachmentId,
  load,
  invalid = false,
  children,
}: {
  name: string;
  file?: File;
  attachmentId?: string;
  load?: (attachmentId: string) => Promise<Blob>;
  invalid?: boolean;
  children?: React.ReactNode;
}) {
  const { url, failed } = useImageUrl(file, attachmentId, load);
  const [open, setOpen] = React.useState(false);

  return (
    <div className="relative size-[52px] shrink-0">
      <button
        type="button"
        disabled={!url}
        title={failed ? `${name} (unavailable)` : name}
        aria-label={failed ? `Image unavailable: ${name}` : `Preview image ${name}`}
        onClick={() => setOpen(true)}
        className={cn(
          focusRingClass,
          "flex size-full items-center justify-center overflow-hidden rounded-lg border bg-secondary-soft text-[length:var(--text-2xs)] text-ink-faint",
          invalid ? "border-danger" : "border-line",
          url ? "cursor-zoom-in" : "cursor-default",
        )}
      >
        {url ? (
          <img src={url} alt={name} className="size-full object-cover" />
        ) : failed ? (
          "!"
        ) : null}
      </button>
      {children}
      {open && url ? (
        <Dialog
          title={<span className="block max-w-[60vw] truncate">{name}</span>}
          onClose={() => setOpen(false)}
          className="w-auto max-w-[calc(100vw-2rem)] border-0 bg-transparent p-0 shadow-none [&_h2]:text-white"
          overlayClassName="bg-black/80"
        >
          <img
            src={url}
            alt={name}
            className="block h-auto max-h-[calc(100vh-8rem)] w-auto max-w-full rounded-md object-contain"
          />
          <div className="mt-2 flex justify-end gap-3 text-[length:var(--text-xs)]">
            <a
              href={url}
              download={name}
              className={cn(focusRingClass, "rounded-sm text-white/80 hover:text-white")}
            >
              Download
            </a>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={cn(focusRingClass, "rounded-sm text-white/80 hover:text-white")}
            >
              Close
            </button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
