"use client";

import { DocumentLibraryView } from "@/components/libraries/document-library-view";

export default function WritePage() {
  return (
    <DocumentLibraryView
      kind="format"
      format="docx"
      title="Write"
      description="Word documents across your workspaces."
    />
  );
}
