import type { ReactNode } from "react";

import {
  MENTION,
  PROMPT,
  type CellState,
  type Scene,
} from "@/components/marketing/product-demo-scene";
import { cn } from "@/lib/utils";

/**
 * Presentational reconstruction of the real workspace (rail, explorer with
 * versions, DOCX canvas, agent panel) at 1000 x 580 design pixels. It reads a
 * Scene and renders it; all timing lives in product-demo.tsx.
 */

const files = ["Monthly-Report.docx", "Sales-Sep.docx", "Onboarding-Guide.docx"];

const versions = [
  { n: 5, when: "Sep 2, 9:41 AM" },
  { n: 6, when: "Sep 30, 4:12 PM" },
  { n: 7, when: "Just now" },
  { n: 8, when: "Just now" },
];

const activity = [
  "Read document structure",
  "Read Sales-Sep.docx",
  "Replaced 2 values as tracked changes",
  "Checked the saved result",
];

const suggestions = [
  "Tighten the executive summary",
  "Update the figures from @Sales-Sep.docx",
  "Add page numbers to the footer",
];

const rows = [
  { item: "Revenue", august: "412,900", before: "452,100", after: "468,300" },
  { item: "New accounts", august: "138", before: "158", after: "171" },
];

export function DemoWorkspace({ s }: { s: Scene }) {
  const history = s.viewing !== null;
  const cells = history ? (["old", "old"] as const) : s.cells;

  return (
    <div
      className={cn(
        "relative h-[580px] w-[1000px] overflow-hidden bg-surface",
        // Loop restart: snap back to the first frame instead of animating backwards.
        s.click === 0 && s.cursor === null && "pd-reset",
      )}
    >
      <TopRail s={s} history={history} />
      <div className="flex h-[544px]">
        <Explorer s={s} />
        <Canvas s={s} cells={cells} history={history} />
        <AgentPanel s={s} />
      </div>
      <ConfirmDialog open={s.dialog} />
    </div>
  );
}

function TopRail({ s, history }: { s: Scene; history: boolean }) {
  return (
    <div className="flex h-9 items-center gap-2 border-b border-line bg-surface pr-3 pl-2 text-[11.5px]">
      <div className="flex h-7 items-center gap-2 rounded-[3px] border border-line bg-paper px-2.5">
        <DocGlyph className="h-3 w-3 text-primary" />
        <span className="font-medium text-ink">Monthly-Report.docx</span>
      </div>
      <div className="flex h-7 items-center gap-2 px-2 text-ink-faint">
        <DocGlyph className="h-3 w-3" />
        <span>Sales-Sep.docx</span>
      </div>
      <span className="ml-auto os-annot text-[11px]">
        {history
          ? `Viewing version ${s.viewing}`
          : s.dirty
            ? "Unsaved"
            : `Saved · v${s.current}`}
      </span>
      <span
        data-t="save"
        className={cn(
          "rounded-[3px] px-2.5 py-1 font-medium transition-colors duration-500",
          s.dirty
            ? "bg-primary text-on-primary"
            : "border border-line bg-paper text-ink-faint",
        )}
      >
        Save
      </span>
      <span className="rounded-[3px] border border-line bg-paper px-2.5 py-1 text-ink-soft">
        Download
      </span>
    </div>
  );
}

function Explorer({ s }: { s: Scene }) {
  const selected = s.viewing ?? s.current;
  return (
    <div className="flex w-[184px] shrink-0 flex-col border-r border-line bg-sidebar">
      <p className="px-3.5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-soft uppercase">
        Files
      </p>
      <ul className="flex flex-col gap-0.5 px-2">
        {files.map((name, i) => (
          <li
            key={name}
            className={cn(
              "relative flex h-[26px] items-center gap-2 rounded-[4px] px-2 text-[11.5px]",
              i === 0 ? "bg-primary-soft font-medium text-ink" : "text-ink-soft",
            )}
          >
            {i === 0 ? (
              <span className="absolute inset-y-1 left-0 w-[2px] rounded-full bg-primary" />
            ) : null}
            <DocGlyph
              className={cn("h-3 w-3", i === 0 ? "text-primary" : "text-ink-faint")}
            />
            <span className="truncate">{name}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex min-h-0 flex-col border-t border-line">
        <p className="px-3.5 pt-3 pb-1.5 text-[10.5px] font-semibold tracking-[0.08em] text-ink-soft uppercase">
          Versions
        </p>
        <ol className="relative px-2 pb-3">
          <span className="absolute top-4 bottom-6 left-[19px] w-px bg-line" />
          {[...versions].reverse().map((v) => {
            const shown = v.n <= s.top;
            const isTip = v.n === s.current;
            const isSelected = v.n === selected;
            return (
              <li
                key={v.n}
                data-t={`v${v.n}`}
                className="grid transition-[grid-template-rows,opacity] duration-700"
                style={{
                  gridTemplateRows: shown ? "1fr" : "0fr",
                  opacity: shown ? 1 : 0,
                }}
              >
                <div className="overflow-hidden">
                  <div
                    className={cn(
                      "relative flex items-center gap-2 rounded-[6px] border py-1.5 pr-2 pl-2 whitespace-nowrap transition-colors duration-500",
                      isSelected
                        ? "border-line bg-elevated shadow-[0_1px_2px_rgba(16,24,40,0.06)]"
                        : "border-transparent",
                    )}
                  >
                    <span className="grid h-4 w-4 shrink-0 place-items-center">
                      <span
                        className={cn(
                          "block rounded-full transition-all duration-500",
                          isTip
                            ? "h-2.5 w-2.5 bg-primary ring-[3px] ring-primary-soft"
                            : isSelected
                              ? "h-2.5 w-2.5 bg-ink-soft ring-[3px] ring-sidebar"
                              : "h-2 w-2 border-[1.5px] border-ink-faint bg-sidebar",
                        )}
                      />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "text-[12px] leading-4",
                            isSelected ? "font-semibold text-ink" : "font-medium text-ink-soft",
                          )}
                        >
                          Version {v.n}
                        </span>
                        <span
                          className={cn(
                            "rounded-full bg-primary-soft px-1.5 text-[10px] leading-4 font-semibold tracking-[0.04em] text-primary uppercase transition-opacity duration-500",
                            isTip ? "opacity-100" : "opacity-0",
                          )}
                        >
                          Current
                        </span>
                      </span>
                      <span className="truncate text-[11px] leading-4 text-ink-faint">
                        {v.when}
                      </span>
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function Canvas({
  s,
  cells,
  history,
}: {
  s: Scene;
  cells: readonly CellState[];
  history: boolean;
}) {
  // Hand edits belong to the current document, not to an older version.
  const sel = history ? "none" : s.sel;
  const h1 = !history && s.h1;
  const bold = !history && s.bold;

  return (
    <div className="relative min-w-0 flex-1 bg-canvas">
      <Toolbar sel={sel} h1={h1} bold={bold} />

      {/* Read-only banner for older versions, as in the real editor. */}
      <div
        className={cn(
          "absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-primary-line bg-primary-soft px-3 py-2 transition-all duration-500",
          history ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
        )}
      >
        <p className="text-[11.5px] leading-snug text-ink-soft">
          Viewing an older version (read-only). To edit it, restore it as
          current — newer versions will be permanently deleted.
        </p>
        <span
          data-t="banner"
          className="shrink-0 rounded-[4px] border border-primary-line bg-surface px-2.5 py-1 text-[11.5px] font-medium text-primary"
        >
          Restore as current
        </span>
      </div>

      {/* The page, centered in the canvas. */}
      <div className="absolute top-[56px] left-1/2 min-h-[560px] w-[380px] -translate-x-1/2 bg-white px-[36px] py-[34px] shadow-[0_1px_2px_rgba(25,25,23,0.06),0_14px_36px_-20px_rgba(25,25,23,0.3)]">
        <p className="text-[8.5px] tracking-[0.14em] text-[#9a968c] uppercase">
          Internal · Finance
        </p>
        <h3
          className={cn(
            "mt-2 font-semibold tracking-[-0.01em] text-[#1d1d1a] transition-[font-size] duration-500",
            h1 ? "text-[20px]" : "text-[14px]",
          )}
        >
          <Selected on={sel === "title"} dt="title">
            Monthly Report — September
          </Selected>
        </h3>
        <p className="mt-2 text-[10.5px] leading-[1.7] text-[#4a4a44]">
          <Selected on={sel === "phrase"} dt="phrase">
            <span className={cn("transition-all duration-300", bold && "font-bold text-[#1d1d1a]")}>
              Revenue and account growth
            </span>
          </Selected>{" "}
          both improved against the prior month, and churn fell for the third
          period running. Figures below are drawn from the monthly sales
          summary.
        </p>
        <table className="mt-3.5 w-full border-collapse text-[10.5px]">
          <thead>
            <tr className="border-b border-[#ddd9cf] text-left text-[9px] tracking-[0.1em] text-[#8a867c] uppercase">
              <th className="h-[26px] font-medium">Line item</th>
              <th className="font-medium">August</th>
              <th className="w-[110px] font-medium">September</th>
            </tr>
          </thead>
          <tbody className="text-[#31312c]">
            {rows.map((row, i) => (
              <tr key={row.item} className="h-[26px] border-b border-[#eeebe2]">
                <td>{row.item}</td>
                <td className="text-[#75736a]">{row.august}</td>
                <td>
                  <Cell state={cells[i] ?? "old"} before={row.before} after={row.after} />
                </td>
              </tr>
            ))}
            <tr className="h-[26px] border-b border-[#eeebe2]">
              <td>Churn</td>
              <td className="text-[#75736a]">2.1%</td>
              <td>1.8%</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3.5 text-[10.5px] leading-[1.7] text-[#4a4a44]">
          Headcount, pricing, and the regional breakdown are unchanged from the
          August edition of this report.
        </p>
        <h4 className="mt-5 text-[11.5px] font-semibold text-[#1d1d1a]">
          Regional breakdown
        </h4>
        <p className="mt-1.5 text-[10.5px] leading-[1.7] text-[#4a4a44]">
          North America remained the largest contributor, with EMEA and APAC
          growing at a similar pace. No region moved by more than two points
          against the prior month.
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-4 text-[10.5px] leading-[1.6] text-[#4a4a44]">
          <li>North America: steady, led by renewals</li>
          <li>EMEA: two new enterprise accounts</li>
          <li>APAC: pipeline ahead of plan</li>
        </ul>
      </div>

      {/* Tracked-change review: a floating tray over the lower page. */}
      <ReviewCard
        index={0}
        open={s.cards[0]}
        top={410}
        item="Revenue"
        before={rows[0]!.before}
        after={rows[0]!.after}
      />
      <ReviewCard
        index={1}
        open={s.cards[1]}
        top={460}
        item="New accounts"
        before={rows[1]!.before}
        after={rows[1]!.after}
      />

      <div
        className={cn(
          "absolute right-3 bottom-3 rounded-[6px] border border-line bg-surface px-3 py-2 shadow-[0_8px_28px_rgba(15,18,24,0.12)] transition-all duration-500",
          s.toast ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
        )}
      >
        <p className="text-[11.5px] font-medium text-ink">Version restored</p>
        <p className="text-[11px] text-ink-faint">Version 6 is current and editable.</p>
      </div>
    </div>
  );
}

/** Text the visitor has "selected" with the mouse. */
function Selected({
  on,
  dt,
  children,
}: {
  on: boolean;
  dt: string;
  children: ReactNode;
}) {
  return (
    <span
      data-t={dt}
      className="rounded-[2px] transition-colors duration-300"
      style={{
        background: on
          ? "color-mix(in srgb, var(--primary) 22%, transparent)"
          : "transparent",
      }}
    >
      {children}
    </span>
  );
}

/** The editor toolbar: the same tools the real DOCX editor has. */
function Toolbar({
  sel,
  h1,
  bold,
}: {
  sel: Scene["sel"];
  h1: boolean;
  bold: boolean;
}) {
  const style = sel === "title" ? (h1 ? "Heading 1" : "Heading 2") : "Normal text";
  return (
    <div className="absolute inset-x-0 top-0 z-[5] flex h-9 items-center gap-0.5 border-b border-line bg-surface px-2">
      <ToolButton>↶</ToolButton>
      <ToolButton>↷</ToolButton>
      <ToolSep />
      <ToolDrop width={44}>100%</ToolDrop>
      <ToolDrop width={92} dt="style">
        <span className="transition-opacity duration-300">{style}</span>
      </ToolDrop>
      <ToolDrop width={66}>Arial</ToolDrop>
      <ToolSep />
      <ToolButton>–</ToolButton>
      <span className="w-6 text-center text-[11px] text-ink">11</span>
      <ToolButton>+</ToolButton>
      <ToolSep />
      <ToolButton dt="bold" active={bold && sel === "phrase"}>
        <span className="font-bold">B</span>
      </ToolButton>
      <ToolButton>
        <span className="italic">I</span>
      </ToolButton>
      <ToolButton>
        <span className="underline">U</span>
      </ToolButton>
      <ToolButton>
        <span className="relative font-semibold">
          A
          <span className="absolute inset-x-0 -bottom-[3px] h-[2px] rounded-full bg-primary" />
        </span>
      </ToolButton>
      <ToolSep />
      <ToolButton>
        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M6 8.5 8.5 6M5.2 5.2 6.4 4a2.4 2.4 0 0 1 3.4 3.4L8.6 8.6M8.8 8.8 7.6 10A2.4 2.4 0 0 1 4.2 6.6" />
        </svg>
      </ToolButton>
      <ToolButton>
        <svg viewBox="0 0 14 14" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
          <path d="M2 3h10v6.5H7L4.5 12V9.5H2Z" />
        </svg>
      </ToolButton>
    </div>
  );
}

function ToolButton({
  children,
  active,
  dt,
}: {
  children: ReactNode;
  active?: boolean;
  dt?: string;
}) {
  return (
    <span
      data-t={dt}
      className={cn(
        "grid h-6 w-6 shrink-0 place-items-center rounded-[4px] text-[12px] text-ink-soft transition-colors duration-300",
        active && "bg-primary-soft text-primary",
      )}
    >
      {children}
    </span>
  );
}

function ToolDrop({
  children,
  width,
  dt,
}: {
  children: ReactNode;
  width: number;
  dt?: string;
}) {
  return (
    <span
      data-t={dt}
      className="flex h-6 shrink-0 items-center justify-between gap-1 rounded-[4px] border border-line bg-paper px-2 text-[11px] text-ink"
      style={{ width }}
    >
      {children}
      <span className="text-[8px] text-ink-faint">▾</span>
    </span>
  );
}

function ToolSep() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-line" />;
}

function Cell({
  state,
  before,
  after,
}: {
  state: CellState;
  before: string;
  after: string;
}) {
  if (state === "tracked") {
    return (
      <span className="whitespace-nowrap">
        <span className="text-[#b3261e] line-through decoration-[#b3261e]/70">{before}</span>{" "}
        <span className="text-[#1a7f55] underline decoration-[#1a7f55]/60 underline-offset-2">
          {after}
        </span>
      </span>
    );
  }
  if (state === "accepted") {
    return (
      <span className="-mx-1 rounded-[3px] bg-primary-soft px-1 py-0.5 font-medium text-primary">
        {after}
      </span>
    );
  }
  return <span className="text-[#31312c]">{before}</span>;
}

function ReviewCard({
  index,
  open,
  top,
  item,
  before,
  after,
}: {
  index: number;
  open: boolean;
  top: number;
  item: string;
  before: string;
  after: string;
}) {
  return (
    <div
      className={cn(
        "absolute left-[122px] flex w-[300px] items-center justify-between gap-3 rounded-[6px] border border-line bg-surface px-3 py-2 shadow-[0_8px_24px_-12px_rgba(15,18,24,0.25)] transition-all duration-500",
        open ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
      )}
      style={{ top }}
    >
      <div className="min-w-0">
        <p className="truncate text-[10px] text-ink-faint">{item} · OpenSuite agent</p>
        <p className="mt-0.5 font-mono text-[11px] text-ink">
          <span className="text-[#b3261e] line-through">{before}</span>
          <span className="px-1 text-ink-faint">→</span>
          <span className="text-[#1a7f55]">{after}</span>
        </p>
      </div>
      <div className="flex shrink-0 gap-1.5">
        <span
          data-t={`reject${index}`}
          className="rounded-[4px] border border-line bg-paper px-2.5 py-1 text-center text-[11px] font-medium text-ink-soft"
        >
          Reject
        </span>
        <span
          data-t={`accept${index}`}
          className="rounded-[4px] bg-primary px-2.5 py-1 text-center text-[11px] font-medium text-on-primary"
        >
          Accept
        </span>
      </div>
    </div>
  );
}

function AgentPanel({ s }: { s: Scene }) {
  const typed = PROMPT.slice(0, s.typed);
  const running = s.sent && !s.done;

  return (
    <div className="relative flex w-[272px] shrink-0 flex-col border-l border-line bg-surface">
      {/* Empty-state hint while the prompt is being written. */}
      <div
        className={cn(
          "absolute inset-x-3 top-[190px] transition-opacity duration-500",
          s.sent ? "opacity-0" : "opacity-100",
        )}
      >
        <p className="os-annot text-[10px] tracking-[0.08em] uppercase">Try asking</p>
        <ul className="mt-2 flex flex-col gap-1.5">
          {suggestions.map((text) => (
            <li
              key={text}
              className="rounded-[6px] border border-line bg-paper px-2.5 py-1.5 text-[11.5px] text-ink-soft"
            >
              {text}
            </li>
          ))}
        </ul>
      </div>

      <div className="flex h-9 items-center justify-between border-b border-line px-3">
        <span className="text-[11.5px] font-medium text-ink">Agent</span>
        <span className="os-annot text-[11px]">Monthly-Report.docx</span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-3 py-3.5">
        {/* An earlier run keeps the thread from looking empty before the prompt. */}
        <div className="border-b border-line pb-3 opacity-70">
          <p className="os-annot text-[10px] tracking-[0.08em] uppercase">Earlier today</p>
          <div className="mt-1.5 flex items-start gap-2 text-[11.5px] leading-[1.5] text-ink-soft">
            <CheckGlyph className="mt-[3px] h-2.5 w-2.5 shrink-0 text-primary" />
            Fixed the heading levels in section 2
          </div>
        </div>

        <Reveal show={s.sent}>
          <div className="rounded-[6px] bg-secondary-soft px-2.5 py-2 text-[12.5px] leading-[1.55] text-ink">
            <PromptText text={PROMPT} />
          </div>
        </Reveal>

        <ul className="flex flex-col gap-2">
          {activity.map((label, i) => {
            const shown = s.steps > i;
            const active = running && s.steps === i + 1;
            return (
              <Reveal key={label} show={shown} as="li">
                <div className="flex items-start gap-2 text-[11.5px] leading-[1.55] text-ink-soft">
                  {active ? (
                    <span className="mt-[6px] ml-[3px] h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
                  ) : (
                    <CheckGlyph className="mt-[3px] h-2.5 w-2.5 shrink-0 text-primary" />
                  )}
                  {label}
                </div>
              </Reveal>
            );
          })}
        </ul>

        <Reveal show={s.done}>
          <p className="text-[12.5px] leading-[1.6] text-ink">
            Updated the two September figures in the summary table as tracked
            changes and left the rest of the report untouched.
          </p>
          <p className="mt-2 border-t border-line pt-2 os-annot text-[11px]">
            <span className="text-ink">Updated document · 19s</span>
          </p>
        </Reveal>
      </div>

      <div
        data-t="composer"
        className={cn(
          "m-3 mt-0 rounded-[6px] border bg-surface p-2 transition-colors duration-500",
          s.focus ? "border-primary-line" : "border-line",
        )}
      >
        <div className="min-h-[58px] text-[12.5px] leading-[1.5] text-ink">
          {s.typed === 0 && !s.focus ? (
            <span className="text-ink-faint">Ask OpenSuite… (@ to tag a file)</span>
          ) : (
            <>
              <PromptText text={typed} />
              {s.focus ? (
                <span className="ml-px inline-block h-[1em] w-px translate-y-[2px] animate-pulse bg-ink" />
              ) : null}
            </>
          )}
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="px-1 text-[13px] text-ink-faint">＋</span>
          <span
            data-t="send"
            className={cn(
              "grid h-6 w-6 place-items-center rounded-[5px] text-[11px] transition-colors duration-500",
              running
                ? "bg-primary text-on-primary"
                : s.typed >= PROMPT.length
                  ? "bg-primary text-on-primary"
                  : "bg-primary-soft text-ink-faint",
            )}
          >
            {running ? (
              <span className="block h-2 w-2 rounded-[1.5px] bg-on-primary" />
            ) : (
              "➤"
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Prompt text with the @-mention styled as the real composer tags it. */
function PromptText({ text }: { text: string }) {
  const at = PROMPT.indexOf(MENTION);
  if (text.length <= at) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span className="rounded-[3px] bg-primary-soft px-0.5 text-primary-hover">
        {text.slice(at, at + MENTION.length)}
      </span>
      {text.slice(at + MENTION.length)}
    </>
  );
}

function Reveal({
  show,
  as: Tag = "div",
  children,
}: {
  show: boolean;
  as?: "div" | "li";
  children: ReactNode;
}) {
  return (
    <Tag
      className={cn(
        "transition-all duration-700",
        show ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
      )}
    >
      {children}
    </Tag>
  );
}

function ConfirmDialog({ open }: { open: boolean }) {
  return (
    <div
      className={cn(
        "absolute inset-0 z-20 grid place-items-center bg-[rgba(25,25,23,0.35)] transition-opacity duration-500",
        open ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className={cn(
          "w-[360px] rounded-[8px] border border-line bg-surface p-5 shadow-[0_24px_80px_rgba(15,18,24,0.2)] transition-transform duration-500",
          open ? "scale-100" : "scale-95",
        )}
      >
        <p className="text-[14px] font-semibold text-ink">Restore this version?</p>
        <p className="mt-2 text-[12px] leading-[1.6] text-ink-soft">
          Newer versions will be permanently deleted from storage. This cannot
          be undone. The selected version becomes current and editable.
        </p>
        <div className="mt-4 flex justify-end gap-2 text-[12px] font-medium">
          <span className="rounded-[5px] border border-line px-3 py-1.5 text-ink-soft">
            Cancel
          </span>
          <span
            data-t="confirm"
            className="rounded-[5px] bg-danger px-3 py-1.5 text-on-primary"
          >
            Restore as current
          </span>
        </div>
      </div>
    </div>
  );
}

export function DemoCursor({ s }: { s: Scene }) {
  const [x, y] = s.cursor ?? [820, 505];
  return (
    <div
      aria-hidden="true"
      className="pd-cursor pointer-events-none absolute z-30"
      style={{ left: x, top: y, opacity: s.cursor ? 1 : 0 }}
    >
      {s.click > 0 ? (
        <span
          key={s.click}
          className="pd-ripple absolute top-0 left-0 h-7 w-7 rounded-full bg-primary"
        />
      ) : null}
      <svg width="16" height="20" viewBox="0 0 16 20" className="relative drop-shadow-sm">
        <path
          d="M1.5 1.2 1.5 15.4 5.2 12.2 7.6 18 10 17 7.7 11.4 12.6 11.2Z"
          fill="#191917"
          stroke="#fff"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function DocGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden="true">
      <rect x="1.75" y="0.75" width="8.5" height="10.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M4 4h4M4 6h4M4 8h2.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 10" className={className} aria-hidden="true">
      <path
        d="M1.5 5.4 3.7 7.6 8.5 2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
