"use client";

import { DocumentLibraryView } from "@/components/libraries/document-library-view";

export default function StarredPage() {
  return (
    <DocumentLibraryView
      kind="starred"
      title="Starred"
      description="Files you have starred across your workspaces."
    />
  );
}
