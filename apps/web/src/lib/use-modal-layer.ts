"use client";

import * as React from "react";

let openModalCount = 0;

/**
 * While any modal is open, mark the document so editor chrome (Casual toolbar)
 * can be hidden and not paint above the dialog.
 */
export function useModalLayer(active = true): void {
  React.useEffect(() => {
    if (!active || typeof document === "undefined") return;
    openModalCount += 1;
    document.documentElement.dataset.opensuiteModal = "1";
    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) {
        delete document.documentElement.dataset.opensuiteModal;
      }
    };
  }, [active]);
}
