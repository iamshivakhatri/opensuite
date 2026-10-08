import type { Timeline } from "@/components/marketing/use-demo-loop";

/**
 * The landing demo as data: one scene object and a timeline of patches.
 * Strings mirror the real workspace (composer placeholder, activity rows,
 * versions rail, "Restore as current"). Nothing here is live.
 */

export type CellState = "old" | "tracked" | "accepted" | "rejected";
export type Camera = readonly [x: number, y: number, zoom: number];

export type Scene = {
  cam: Camera;
  /** characters of PROMPT typed into the composer */
  typed: number;
  focus: boolean;
  sent: boolean;
  /** agent activity rows shown (0-4) */
  steps: number;
  done: boolean;
  cells: readonly [CellState, CellState];
  cards: readonly [boolean, boolean];
  dirty: boolean;
  /** hand edits in the editor: what is selected, heading applied, bold applied */
  sel: "none" | "title" | "phrase";
  h1: boolean;
  bold: boolean;
  /** newest version that exists, and which one is current */
  top: number;
  current: number;
  viewing: number | null;
  dialog: boolean;
  toast: boolean;
  cursor: readonly [number, number] | null;
  /** increments per click; 0 = none */
  click: number;
  chapter: number;
};

export const PROMPT =
  "Update the September figures from @Sales-Sep.docx and show them as tracked changes.";
export const MENTION = "@Sales-Sep.docx";

export const chapters = [
  { name: "Prompt", note: "Ask in plain language, @-tag a file" },
  { name: "Run", note: "Reads, edits through the engine, saves" },
  { name: "Review", note: "Accept or reject each tracked change" },
  { name: "Edit", note: "Every editing tool, by hand, any time" },
  { name: "Restore", note: "Open any version, restore it as current" },
];

const WIDE: Camera = [500, 290, 1];
const COMPOSER: Camera = [760, 360, 1.45];
const PANEL: Camera = [850, 300, 1.55];
const DOC: Camera = [456, 270, 1.9];
const REVIEW: Camera = [456, 380, 1.5];
const EDIT: Camera = [456, 190, 1.7];
const SAVE: Camera = [800, 140, 1.7];
const RAIL: Camera = [190, 430, 1.7];
const BANNER: Camera = [480, 160, 1.6];
const DIALOG: Camera = [520, 310, 1.6];

/** Cursor stops, in design pixels (measured from the rendered frame). */
const P = {
  composer: [850, 505],
  send: [966, 547],
  rest: [560, 450],
  accept: [564, 472],
  reject: [503, 522],
  title: [354, 148],
  style: [347, 54],
  phraseStart: [296, 175],
  phraseEnd: [432, 175],
  bold: [567, 54],
  save: [881, 17],
  v6: [91, 496],
  banner: [655, 59],
  confirm: [595, 341],
} as const;

export const END_STATE: Scene = {
  cam: WIDE,
  typed: 0,
  focus: false,
  sent: false,
  steps: 0,
  done: false,
  cells: ["old", "old"],
  cards: [false, false],
  dirty: false,
  sel: "none",
  h1: false,
  bold: false,
  top: 6,
  current: 6,
  viewing: null,
  dialog: false,
  toast: false,
  cursor: null,
  click: 0,
  chapter: 0,
};

/** What reduced-motion and no-JS visitors see: the review moment. */
export const POSTER: Scene = {
  ...END_STATE,
  sent: true,
  steps: 4,
  done: true,
  cells: ["tracked", "tracked"],
  cards: [true, true],
  top: 7,
  current: 7,
  chapter: 2,
};

function buildTimeline(): { events: Timeline<Scene>[number][]; length: number } {
  const events: Timeline<Scene>[number][] = [];
  const at = (ms: number, patch: Partial<Scene>) => events.push([ms, patch]);

  at(0, END_STATE);
  at(500, { cursor: P.composer, cam: COMPOSER });
  at(1500, { click: 1, focus: true });
  for (let i = 1; i <= PROMPT.length; i++) at(1800 + i * 48, { typed: i });

  at(5900, { cursor: P.send });
  at(6700, { click: 2, sent: true, typed: 0, focus: false });
  at(7000, { cam: PANEL, chapter: 1, cursor: P.rest });
  at(7600, { steps: 1 });
  at(8400, { steps: 2 });
  at(9200, { steps: 3, cam: DOC });
  at(9500, { cells: ["tracked", "old"] });
  at(9800, { cells: ["tracked", "tracked"] });
  at(10600, { steps: 4, top: 7, current: 7, cam: WIDE });
  at(11300, { done: true });

  at(12200, { cam: REVIEW, cards: [true, true], chapter: 2 });
  at(13100, { cursor: P.accept });
  at(13800, { click: 3, cells: ["accepted", "tracked"], cards: [false, true], dirty: true });
  at(14600, { cursor: P.reject });
  at(15300, { click: 4, cells: ["accepted", "rejected"], cards: [false, false] });

  // By hand: restyle the title, bold a phrase, using the editor toolbar.
  at(16000, { cam: EDIT, chapter: 3, cursor: P.title });
  at(16800, { click: 5, sel: "title" });
  at(17500, { cursor: P.style });
  at(18200, { click: 6, h1: true });
  at(19000, { cursor: P.phraseStart });
  at(19600, { cursor: P.phraseEnd, sel: "phrase" });
  at(20400, { cursor: P.bold });
  at(21000, { click: 7, bold: true });

  at(21900, { cursor: P.save, cam: SAVE, sel: "none" });
  at(22700, { click: 8, dirty: false, top: 8, current: 8 });

  at(23700, { cursor: P.v6, cam: RAIL, chapter: 4 });
  at(24500, { click: 9, viewing: 6 });
  at(25200, { cursor: P.banner, cam: BANNER });
  at(26800, { click: 10, dialog: true, cam: DIALOG });
  at(27800, { cursor: P.confirm });
  at(28600, {
    click: 11,
    dialog: false,
    viewing: null,
    current: 6,
    top: 6,
    cells: ["old", "old"],
    h1: false,
    bold: false,
    toast: true,
    cam: WIDE,
  });
  at(29100, { cursor: null });
  at(31400, { toast: false });

  return { events, length: 32900 };
}

export const { events: TIMELINE, length: LOOP_MS } = buildTimeline();

/** Camera -> CSS transform, clamped so the frame never shows empty edges. */
export function cameraTransform([x, y, zoom]: Camera): string {
  const clamp = (v: number, min: number, max: number) =>
    Math.min(max, Math.max(min, v));
  const tx = clamp(500 - x * zoom, 1000 - 1000 * zoom, 0);
  const ty = clamp(290 - y * zoom, 580 - 580 * zoom, 0);
  return `translate(${tx}px, ${ty}px) scale(${zoom})`;
}
