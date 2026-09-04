"use client";

import { use } from "react";

import { DocumentWorkspace } from "@/components/documents/document-workspace";

export default function DocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = use(params);
  return <DocumentWorkspace documentId={documentId} />;
}
