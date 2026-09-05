"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { ApiError, getDocument } from "@/lib/api";
import { documentPath } from "@/lib/paths";

/**
 * Preserve old `/app/documents/:id` URLs with a clean redirect into the
 * workspace-scoped document route.
 */
export default function LegacyDocumentRedirectPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = React.use(params);
  const router = useRouter();
  const [message, setMessage] = React.useState("Opening document…");

  React.useEffect(() => {
    let cancelled = false;
    void getDocument(documentId)
      .then((document) => {
        if (cancelled) return;
        router.replace(documentPath(document.workspaceId, document.id));
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.statusCode === 404) {
          setMessage("Document not found.");
          return;
        }
        setMessage("Could not open this document.");
      });
    return () => {
      cancelled = true;
    };
  }, [documentId, router]);

  return (
    <div className="grid h-screen place-items-center text-[13px] text-ink-soft">
      {message}
    </div>
  );
}
