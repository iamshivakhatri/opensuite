/**
 * Pure theme model — preference vs resolved, storage keys, DOM contract.
 * React provider lives in theme.tsx; embedded editors sync via helpers here.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** Persisted user preference (never overwritten by resolved OS theme). */
export const THEME_STORAGE_KEY = "opensuite.theme";

/**
 * OpenSuite's sole documentElement theme attribute.
 * Casual Docs mutates `data-theme` on <html>; we must not share that name.
 */
export const OPENSUITE_THEME_ATTR = "data-opensuite-theme";

/**
 * Casual Docs stores UI chrome theme here and applies it to `data-theme` on
 * <html>. We force light|dark (never auto) so it cannot follow OS independently.
 */
export const CASUAL_COLOR_THEME_KEY = "casual-editor:color-theme";

export function resolveTheme(
  preference: ThemePreference,
  systemIsDark: boolean,
): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemIsDark ? "dark" : "light";
}

export function parseThemePreference(raw: string | null): ThemePreference {
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "system";
}

export function readSystemIsDark(
  matchMedia: ((query: string) => MediaQueryList) | undefined = globalThis
    .matchMedia,
): boolean {
  if (typeof matchMedia !== "function") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Apply OpenSuite resolved theme. Also mirrors onto Casual's `data-theme` +
 * localStorage so embedded Docs chrome matches without owning app preference.
 */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute(OPENSUITE_THEME_ATTR, resolved);
  root.style.colorScheme = resolved;
  syncEmbeddedEditorColorTheme(resolved);
}

/** Keep Casual Docs (and future Sheets/Slides) as theme consumers only. */
export function syncEmbeddedEditorColorTheme(resolved: ResolvedTheme): void {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(CASUAL_COLOR_THEME_KEY, resolved);
    } catch {
      // ignore quota / private mode
    }
  }
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", resolved);
  }
}
