"use client";

import { DocumentLibraryView } from "@/components/libraries/document-library-view";

export default function RecentPage() {
  return (
    <DocumentLibraryView
      kind="recent"
      title="Recent"
      description="Documents you opened recently, newest first."
    />
  );
}
