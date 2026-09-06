"use client";

import * as React from "react";
import { DocxEditor, type DocxEditorRef } from "@casualoffice/docs";
import "@casualoffice/docs/styles.css";
import "@/lib/schnsrw-wasm-asset";
import {
  syncEmbeddedEditorColorTheme,
  type ResolvedTheme,
} from "@/lib/theme";

/**
 * Client-only Casual DocxEditor mount. Keep Casual types/imports here —
 * they must not leak into agent-core, API, or DB layers.
 *
 * Theme: OpenSuite owns preference/resolved theme. We sync Casual's
 * `casual-editor:color-theme` + `data-theme` to resolvedTheme so Casual
 * never follows OS independently or flips the app shell.
 */
export const DocxEditorHost = React.forwardRef<
  DocxEditorRef,
  {
    readonly documentBuffer: ArrayBuffer;
    readonly documentName: string;
    readonly resolvedTheme: ResolvedTheme;
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
    resolvedTheme,
    onDirtyChange,
    onReady,
    onError,
    onSelectionChange,
    onSaveRequest,
  },
  ref,
) {
  // Sync before paint so Casual's mount effect reads the correct localStorage.
  React.useLayoutEffect(() => {
    syncEmbeddedEditorColorTheme(resolvedTheme);
  }, [resolvedTheme]);

  return (
    <div
      className="opensuite-docx-host h-full min-h-0 w-full"
      data-theme={resolvedTheme}
      data-opensuite-editor="docx"
    >
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
