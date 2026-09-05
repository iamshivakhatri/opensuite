"use client";

import { use } from "react";

import { DocumentWorkspace } from "@/components/documents/document-workspace";

export default function WorkspaceDocumentPage({
  params,
}: {
  params: Promise<{ workspaceId: string; documentId: string }>;
}) {
  const { documentId } = use(params);
  return <DocumentWorkspace documentId={documentId} />;
}
