"use client";

import * as React from "react";
import { DocxEditor, type DocxEditorRef } from "@casualoffice/docs";
import "@casualoffice/docs/styles.css";

/**
 * Client-only Casual DocxEditor mount. Keep Casual types/imports here —
 * they must not leak into agent-core, API, or DB layers.
 */
export const DocxEditorHost = React.forwardRef<
  DocxEditorRef,
  {
    readonly documentBuffer: ArrayBuffer;
    readonly documentName: string;
    readonly onDirtyChange: (dirty: boolean) => void;
    readonly onReady?: (api: DocxEditorRef) => void;
    readonly onError?: (error: Error) => void;
    readonly onSelectionChange?: (selection: unknown) => void;
    readonly onSaveRequest?: (bytes: ArrayBuffer) => void;
  }
>(function DocxEditorHost(
  {
    documentBuffer,
    documentName,
    onDirtyChange,
    onReady,
    onError,
    onSelectionChange,
    onSaveRequest,
  },
  ref,
) {
  return (
    <div className="opensuite-docx-host h-full min-h-0 w-full">
      <DocxEditor
        ref={ref}
        documentBuffer={documentBuffer}
        documentName={documentName}
        documentNameEditable={false}
        documentMode="editing"
        chrome="embedded"
        ai={{ enabled: false }}
        features={{
          titleBar: false,
          menuBar: false,
          panelRail: false,
          statusBar: false,
          printButton: false,
          outline: false,
        }}
        className="h-full min-h-0"
        style={{ height: "100%", minHeight: 0 }}
        onDirtyChange={onDirtyChange}
        onReady={onReady}
        onError={onError}
        onSelectionChange={onSelectionChange}
        onSave={onSaveRequest}
      />
    </div>
  );
});
