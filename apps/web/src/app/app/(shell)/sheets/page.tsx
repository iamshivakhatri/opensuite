"use client";

import { DocumentLibraryView } from "@/components/libraries/document-library-view";

export default function SheetsPage() {
  return (
    <DocumentLibraryView
      kind="format"
      format="xlsx"
      title="Sheets"
      description="Excel workbooks across your workspaces."
    />
  );
}
