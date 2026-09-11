/**
 * Pure helpers for workspace open-tab order (sessionStorage list).
 */

export type OpenTabMeta = {
  readonly id: string;
  readonly name: string;
  readonly format: "docx" | "pptx" | "xlsx";
};

/**
 * Insert or refresh a tab without changing relative order.
 * Existing tabs stay put; brand-new tabs append at the end.
 */
export function upsertOpenTab(
  tabs: readonly OpenTabMeta[],
  tab: OpenTabMeta,
): OpenTabMeta[] {
  const index = tabs.findIndex((item) => item.id === tab.id);
  if (index < 0) return [...tabs, tab];
  const current = tabs[index]!;
  if (
    current.name === tab.name &&
    current.format === tab.format &&
    current.id === tab.id
  ) {
    return tabs as OpenTabMeta[];
  }
  const next = tabs.slice();
  next[index] = tab;
  return next;
}
