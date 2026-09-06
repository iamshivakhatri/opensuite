"use client";

import * as React from "react";

import {
  applyResolvedTheme,
  parseThemePreference,
  readSystemIsDark,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme-model";

export type { ResolvedTheme, ThemePreference };
export {
  applyResolvedTheme,
  CASUAL_COLOR_THEME_KEY,
  OPENSUITE_THEME_ATTR,
  resolveTheme,
  syncEmbeddedEditorColorTheme,
  THEME_STORAGE_KEY,
} from "@/lib/theme-model";

function readStoredPreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
}

type ThemeContextValue = {
  /** User preference shown in Settings (system | light | dark). */
  readonly themePreference: ThemePreference;
  /** Effective light | dark after resolving system. */
  readonly resolvedTheme: ResolvedTheme;
  readonly setThemePreference: (value: ThemePreference) => void;
};

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

/**
 * Single owner of OpenSuite theme DOM state (`data-opensuite-theme`).
 * Other packages must not mutate that attribute.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themePreference, setThemePreferenceState] =
    React.useState<ThemePreference>(() =>
      typeof window === "undefined" ? "system" : readStoredPreference(),
    );
  const [systemIsDark, setSystemIsDark] = React.useState(() =>
    typeof window === "undefined" ? false : readSystemIsDark(),
  );

  React.useEffect(() => {
    const stored = readStoredPreference();
    setThemePreferenceState(stored);
    setSystemIsDark(readSystemIsDark());
    applyResolvedTheme(resolveTheme(stored, readSystemIsDark()));

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const nextSystemDark = media.matches;
      setSystemIsDark(nextSystemDark);
      const preference = readStoredPreference();
      if (preference === "system") {
        applyResolvedTheme(resolveTheme("system", nextSystemDark));
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const resolvedTheme = resolveTheme(themePreference, systemIsDark);

  const setThemePreference = React.useCallback((next: ThemePreference) => {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemePreferenceState(next);
    applyResolvedTheme(resolveTheme(next, readSystemIsDark()));
  }, []);

  // Keep DOM in sync when preference or system flag changes after mount.
  React.useEffect(() => {
    applyResolvedTheme(resolvedTheme);
  }, [resolvedTheme]);

  const value = React.useMemo(
    () => ({ themePreference, resolvedTheme, setThemePreference }),
    [themePreference, resolvedTheme, setThemePreference],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}

/** @deprecated Use themePreference / setThemePreference. */
export function readStoredTheme(): ThemePreference {
  return readStoredPreference();
}
