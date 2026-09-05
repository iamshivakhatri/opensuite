export type IdePanelPrefs = {
  explorerWidth: number;
  agentWidth: number;
  explorerCollapsed: boolean;
  agentCollapsed: boolean;
};

const STORAGE_KEY = "opensuite.idePanels";

const DEFAULTS: IdePanelPrefs = {
  explorerWidth: 220,
  agentWidth: 320,
  explorerCollapsed: false,
  agentCollapsed: false,
};

export const PANEL_LIMITS = {
  explorerMin: 180,
  explorerMax: 360,
  agentMin: 260,
  agentMax: 480,
} as const;

export function readIdePanelPrefs(): IdePanelPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<IdePanelPrefs>;
    return {
      explorerWidth: clamp(
        Number(parsed.explorerWidth) || DEFAULTS.explorerWidth,
        PANEL_LIMITS.explorerMin,
        PANEL_LIMITS.explorerMax,
      ),
      agentWidth: clamp(
        Number(parsed.agentWidth) || DEFAULTS.agentWidth,
        PANEL_LIMITS.agentMin,
        PANEL_LIMITS.agentMax,
      ),
      explorerCollapsed: Boolean(parsed.explorerCollapsed),
      agentCollapsed: Boolean(parsed.agentCollapsed),
    };
  } catch {
    return DEFAULTS;
  }
}

export function writeIdePanelPrefs(prefs: IdePanelPrefs): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
