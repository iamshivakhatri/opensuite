import * as React from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** Keyboard focus ring — visible only for :focus-visible. */
export const focusRingClass =
  "outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function getFocusableElements(
  container: HTMLElement,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((el) => {
    if (el.hasAttribute("disabled")) return false;
    if (el.getAttribute("aria-disabled") === "true") return false;
    if (el.tabIndex < 0) return false;
    if (el.closest("[inert]")) return false;
    // getClientRects works for position:fixed (offsetParent is null).
    return el.getClientRects().length > 0;
  });
}

/**
 * When `active`, move focus into `containerRef`, trap Tab, restore on cleanup.
 */
export function useFocusScope(
  active: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  options?: { restoreFocus?: boolean },
) {
  const restoreFocus = options?.restoreFocus !== false;
  const previousFocusRef = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!active) return;
    const root = containerRef.current;
    if (!root) return;
    const container: HTMLElement = root;

    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    if (!container.contains(document.activeElement)) {
      const focusables = getFocusableElements(container);
      const target = focusables[0] ?? container;
      target.focus({ preventScroll: true });
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("keydown", onKeyDown);
      if (restoreFocus) {
        const prev = previousFocusRef.current;
        if (prev && typeof prev.focus === "function") {
          prev.focus({ preventScroll: true });
        }
      }
    };
  }, [active, containerRef, restoreFocus]);
}

/**
 * Arrow / Home / End roving focus for role=menu containers.
 * Returns true when the event was handled.
 */
export function handleMenuRovingKeys(
  event: KeyboardEvent | React.KeyboardEvent,
  menu: HTMLElement,
): boolean {
  const items = getFocusableElements(menu);
  if (items.length === 0) return false;
  const index = items.indexOf(document.activeElement as HTMLElement);
  if (event.key === "ArrowDown") {
    event.preventDefault();
    const next = items[(index + 1 + items.length) % items.length]!;
    next.focus({ preventScroll: true });
    return true;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    const next = items[(index - 1 + items.length) % items.length]!;
    next.focus({ preventScroll: true });
    return true;
  }
  if (event.key === "Home") {
    event.preventDefault();
    items[0]!.focus({ preventScroll: true });
    return true;
  }
  if (event.key === "End") {
    event.preventDefault();
    items[items.length - 1]!.focus({ preventScroll: true });
    return true;
  }
  return false;
}
