/**
 * Pure tab-overflow partitioning for the document tab strip.
 * Keeps the active tab visible and grows a contiguous window around it.
 */

export type TabOverflowPartition<T extends { readonly id: string }> = {
  readonly visible: readonly T[];
  readonly overflow: readonly T[];
};

export type PartitionTabsForOverflowOptions<T extends { readonly id: string }> =
  {
    readonly activeId: string | null;
    /** Full strip width (controls are subtracted inside). */
    readonly availableWidth: number;
    readonly openButtonWidth: number;
    readonly overflowButtonWidth: number;
    readonly minTabWidth: number;
    readonly maxTabWidth: number;
    readonly estimateTabWidth: (tab: T) => number;
  };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Prefer a contiguous window of tabs that always includes the active tab.
 * When everything fits, overflow is empty and the overflow control width is
 * not reserved.
 */
export function partitionTabsForOverflow<T extends { readonly id: string }>(
  tabs: readonly T[],
  options: PartitionTabsForOverflowOptions<T>,
): TabOverflowPartition<T> {
  if (tabs.length === 0) {
    return { visible: [], overflow: [] };
  }

  const widths = tabs.map((tab) =>
    clamp(
      options.estimateTabWidth(tab),
      options.minTabWidth,
      options.maxTabWidth,
    ),
  );
  const total = widths.reduce((sum, width) => sum + width, 0);
  const fitWithoutOverflow =
    options.availableWidth - options.openButtonWidth;

  if (total <= fitWithoutOverflow) {
    return { visible: tabs, overflow: [] };
  }

  const budget = Math.max(
    options.minTabWidth,
    options.availableWidth -
      options.openButtonWidth -
      options.overflowButtonWidth,
  );

  let activeIndex = tabs.findIndex((tab) => tab.id === options.activeId);
  if (activeIndex < 0) activeIndex = 0;

  let left = activeIndex;
  let right = activeIndex;
  let used = widths[activeIndex] ?? options.minTabWidth;

  // Always keep the active tab even if it alone exceeds the budget.
  while (true) {
    const nextLeft = left - 1;
    const nextRight = right + 1;
    const canLeft =
      nextLeft >= 0 && used + (widths[nextLeft] ?? 0) <= budget;
    const canRight =
      nextRight < tabs.length && used + (widths[nextRight] ?? 0) <= budget;

    if (!canLeft && !canRight) break;

    // Expand toward the side that still has more hidden tabs.
    const remainingLeft = left;
    const remainingRight = tabs.length - 1 - right;
    if (canRight && (!canLeft || remainingRight >= remainingLeft)) {
      right = nextRight;
      used += widths[right] ?? 0;
    } else if (canLeft) {
      left = nextLeft;
      used += widths[left] ?? 0;
    } else {
      break;
    }
  }

  return {
    visible: tabs.slice(left, right + 1),
    overflow: [...tabs.slice(0, left), ...tabs.slice(right + 1)],
  };
}

/** Rough chrome + label width for layout estimates before paint. */
export function estimateDocumentTabWidth(input: {
  readonly name: string;
  readonly dirty?: boolean;
}): number {
  // format icon (~16) + gaps/padding (~28) + close (~18) + optional dirty (~10)
  const chrome = 16 + 28 + 18 + (input.dirty ? 10 : 0);
  const label = Math.ceil(input.name.length * 6.6);
  return chrome + label;
}
