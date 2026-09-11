import * as React from "react";

/**
 * Keep the browser tab title stable. Soft navigations and embedded editors
 * otherwise briefly flash a path or document name.
 */
export function useStableBrowserTitle(title: string): void {
  React.useEffect(() => {
    const apply = () => {
      if (typeof document === "undefined") return;
      if (document.title !== title) document.title = title;
    };

    apply();

    const node = document.querySelector("title");
    if (!node || typeof MutationObserver === "undefined") {
      return;
    }

    const observer = new MutationObserver(apply);
    observer.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
    });

    return () => observer.disconnect();
  }, [title]);
}
