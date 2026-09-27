import * as React from "react";

/**
 * Overlay dismiss that ignores click sequences that started inside the dialog
 * (e.g. selecting text in an input and releasing the mouse outside).
 */
export function useOverlayDismiss(
  onDismiss: () => void,
  enabled = true,
): {
  readonly onPointerDown: React.PointerEventHandler<HTMLElement>;
  readonly onClick: React.MouseEventHandler<HTMLElement>;
} {
  const startedOnOverlayRef = React.useRef(false);

  return {
    onPointerDown: (event) => {
      startedOnOverlayRef.current = event.target === event.currentTarget;
    },
    onClick: (event) => {
      if (!enabled) return;
      if (!startedOnOverlayRef.current) return;
      if (event.target !== event.currentTarget) return;
      onDismiss();
    },
  };
}
