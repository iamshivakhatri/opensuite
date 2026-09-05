"use client";

import { DocumentLibraryView } from "@/components/libraries/document-library-view";

export default function SlidesPage() {
  return (
    <DocumentLibraryView
      kind="format"
      format="pptx"
      title="Slides"
      description="PowerPoint files across your workspaces."
    />
  );
}
