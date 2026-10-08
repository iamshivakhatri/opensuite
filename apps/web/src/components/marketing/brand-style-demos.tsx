"use client";

import type { CSSProperties, ReactNode, Ref } from "react";

import {
  useDemoLoop,
  type Timeline,
} from "@/components/marketing/use-demo-loop";
import { cn } from "@/lib/utils";

/**
 * Three looping illustrations for the landing "Brand & styles" section.
 * Each is a scene of `step` (and `typed`) driven by useDemoLoop and drawn on
 * a padded 480 x 340 design stage that CSS scales to its container. They are
 * designed to look good first; "Meridian Studio" is a made-up company. One calm brand
 * color on warm paper; no gradients, glows, or sparkle icons.
 */

const BRAND = "#1F3D36";
const BRAND_HEX = "#1F3D36";
const PALETTE = [BRAND, "#4E6B61", "#9DB1A8", "#C6A56B", "#EDE5D3"];
const COMPANY = "Meridian Studio";
const STYLE_NAME = "Meridian Quarterly";
const FILE_NAME = "Meridian-Q3-Report.docx";

const SERIF = "var(--font-serif), Georgia, serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const BACKDROP = "linear-gradient(160deg, #fdfcfa 0%, #f5f3ec 100%)";

type Step = { step: number };
type Typing = Step & { typed: number };

/* ── shared pieces ───────────────────────────────────────────────────────── */

function MiniStage({
  stageRef,
  fade,
  reset,
  children,
}: {
  stageRef: Ref<HTMLDivElement>;
  fade: boolean;
  reset: boolean;
  children: ReactNode;
}) {
  return (
    <div
      ref={stageRef}
      aria-hidden="true"
      className="mini-frame relative overflow-hidden rounded-[8px] border border-[var(--rule)] bg-surface shadow-[0_1px_1px_rgba(25,25,23,0.03),0_24px_60px_-34px_rgba(25,25,23,0.28)]"
      style={{ backgroundImage: BACKDROP }}
    >
      <div className="mini-scale">
        <div
          className="relative h-[340px] w-[480px] transition-opacity duration-700"
          style={{ opacity: fade ? 0 : 1 }}
        >
          <div className={cn("absolute inset-0", reset && "mini-reset")}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

function Card({
  className,
  style,
  children,
}: {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute top-6 h-[270px] overflow-hidden rounded-[10px] border border-line bg-surface shadow-[0_1px_2px_rgba(25,25,23,0.05),0_20px_40px_-24px_rgba(25,25,23,0.4)]",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

function Caption({ left, children }: { left: number; children: ReactNode }) {
  return (
    <p
      className="absolute top-[304px] font-mono text-[9.5px] text-ink-faint"
      style={{ left }}
    >
      {children}
    </p>
  );
}

const show = (on: boolean) =>
  cn(
    "transition-all duration-700",
    on ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
  );

/** Text that is "typed" in by growing its clip width in character steps. */
function Typed({ text }: { text: string }) {
  return (
    <span
      className="inline-block overflow-hidden align-bottom whitespace-nowrap"
      style={{
        maxWidth: `${text.length + 1}ch`,
        transition: `max-width ${Math.min(1.4, text.length * 0.06)}s steps(${text.length})`,
      }}
    >
      {text}
    </span>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="text-[9px] font-semibold tracking-[0.09em] text-ink-faint uppercase">
      {children}
    </p>
  );
}

function Mark({ className }: { className?: string }) {
  return (
    <span
      className={cn("grid place-items-center rounded-[6px] text-white", className)}
      style={{ background: BRAND }}
    >
      <svg viewBox="0 0 16 16" className="h-[70%] w-[70%]" aria-hidden="true">
        <text
          x="8"
          y="12.2"
          textAnchor="middle"
          fontSize="12"
          fill="currentColor"
          style={{ fontFamily: SERIF }}
        >
          M
        </text>
      </svg>
    </span>
  );
}

/**
 * One page of a report. Presentational: the caller says how much of the
 * brand is applied, and `ring` outlines the parts the scan has found.
 */
function Doc({
  title,
  logo = false,
  name = false,
  tint,
  brandFont,
  bodySans = true,
  ring = {},
}: {
  title: string;
  logo?: boolean;
  name?: boolean;
  tint: boolean;
  brandFont: boolean;
  bodySans?: boolean;
  ring?: { title?: boolean; body?: boolean; table?: boolean };
}) {
  const accent = tint ? BRAND : "#2a2a26";
  const headFont = brandFont ? SERIF : "Arial, Helvetica, sans-serif";
  const outline = (on?: boolean): CSSProperties => ({
    outline: `1.5px solid ${on ? BRAND : "transparent"}`,
    outlineOffset: 3,
    borderRadius: 3,
    transition: "outline-color 0.5s",
  });

  return (
    <div
      className="flex h-full flex-col bg-white px-4 py-3.5"
      style={{ fontFamily: bodySans ? SANS : "Georgia, 'Times New Roman', serif" }}
    >
      <div className="flex h-[16px] items-center gap-1.5">
        <Mark
          className={cn(
            "h-[14px] w-[14px] transition-opacity duration-700",
            logo ? "opacity-100" : "opacity-0",
          )}
        />
        <span
          className={cn(
            "text-[8.5px] font-semibold text-[#31312c] transition-opacity duration-700",
            name ? "opacity-100" : "opacity-0",
          )}
        >
          {COMPANY}
        </span>
      </div>

      <div className="mt-2 self-start" style={outline(ring.title)}>
        <p
          className="text-[18px] leading-none font-semibold tracking-[-0.015em] transition-colors duration-700"
          style={{ color: accent, fontFamily: headFont }}
        >
          {title}
        </p>
      </div>

      <span className="relative mt-2.5 block h-[2px] w-12 rounded-full bg-[#dedad0]">
        <span
          className="absolute inset-0 rounded-full transition-opacity duration-700"
          style={{
            background: BRAND,
            opacity: tint ? 1 : 0,
          }}
        />
      </span>

      <div className="mt-2.5" style={outline(ring.body)}>
        <p className="text-[9px] leading-[1.7] text-[#4a4a44]">
          Revenue grew 12% this quarter and retention hit a record high.
        </p>
      </div>

      <div className="mt-3 flex gap-6">
        {[
          ["$3.8M", "Revenue"],
          ["94%", "Retention"],
        ].map(([value, label]) => (
          <div key={label}>
            <p
              className="text-[16px] leading-none font-semibold transition-colors duration-700"
              style={{ color: accent, fontFamily: headFont }}
            >
              {value}
            </p>
            <p className="mt-1 text-[8px] text-[#8a867c]">{label}</p>
          </div>
        ))}
      </div>

      <div className="mt-3" style={outline(ring.table)}>
        <div className="overflow-hidden rounded-[3px] text-[8.5px]">
          <div
            className="flex justify-between px-2 py-[3px] font-semibold transition-colors duration-700"
            style={{
              background: tint ? BRAND : "#e5e2d9",
              color: tint ? "#fff" : "#6a675d",
            }}
          >
            <span>Metric</span>
            <span>Q3</span>
          </div>
          {[
            ["Members", "4,250"],
            ["Churn", "1.8%"],
            ["Backlog", "18"],
          ].map(([k, v]) => (
            <div
              key={k}
              className="flex justify-between border-b border-[#eeebe2] px-2 py-[3px] text-[#4a4a44]"
            >
              <span>{k}</span>
              <span>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── 1. Brand: fill in the form, watch the next document become yours ────── */

const brandTimeline: Timeline<Step> = [
  [0, { step: 0 }],
  [600, { step: 1 }],
  [1500, { step: 2 }],
  [2600, { step: 3 }],
  [3700, { step: 4 }],
  [4800, { step: 5 }],
  [5700, { step: 6 }],
];

export function BrandDemo({ paused }: { paused: boolean }) {
  const { scene, fade, ref } = useDemoLoop(brandTimeline, 9200, { step: 6 }, paused);
  const s = scene.step;
  return (
    <MiniStage stageRef={ref} fade={fade} reset={s === 0}>
      <Card className="left-6 w-[196px] p-3.5">
        <div>
          <Label>Organization</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="relative grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[7px] border border-dashed border-[var(--rule)]">
              <Mark
                className={cn(
                  "absolute inset-0 rounded-[7px] transition-all duration-700",
                  s >= 1 ? "scale-100 opacity-100" : "scale-75 opacity-0",
                )}
              />
            </span>
            <span className="flex h-[26px] min-w-0 flex-1 items-center overflow-hidden rounded-[5px] border border-line bg-paper px-1.5 text-[11px] text-ink">
              {s >= 2 ? <Typed text={COMPANY} /> : <span className="text-ink-faint">Company</span>}
            </span>
          </div>
        </div>

        <div className="mt-3">
          <Label>Brand color</Label>
          <div className="mt-1.5 flex items-center gap-2">
            <span
              className="h-[26px] w-[26px] shrink-0 rounded-[6px] border border-line transition-colors duration-700"
              style={{ background: s >= 3 ? BRAND : "transparent" }}
            />
            <span className="flex h-[26px] flex-1 items-center rounded-[5px] border border-line bg-paper px-1.5 font-mono text-[11px] text-ink">
              {s >= 3 ? <Typed text={BRAND_HEX} /> : <span className="text-ink-faint">#123456</span>}
            </span>
          </div>
          <div className="mt-2 flex gap-1.5">
            {PALETTE.map((color, i) => (
              <span
                key={color}
                className="h-3.5 w-3.5 rounded-full transition-all duration-500"
                style={{
                  background: color,
                  opacity: s >= 3 ? 1 : 0,
                  transform: s >= 3 ? "scale(1)" : "scale(0.4)",
                  transitionDelay: `${i * 90}ms`,
                }}
              />
            ))}
          </div>
        </div>

        <div className="mt-3">
          <Label>Heading font</Label>
          <span className="mt-1.5 flex h-[26px] items-center overflow-hidden rounded-[5px] border border-line bg-paper px-1.5 text-[12px] text-ink">
            {s >= 4 ? (
              <span style={{ fontFamily: SERIF }}>
                <Typed text="Source Serif 4" />
              </span>
            ) : (
              <span className="text-[11px] text-ink-faint">Choose a font</span>
            )}
          </span>
        </div>

        <span
          className={cn(
            "mt-3 inline-flex items-center rounded-[5px] px-3 py-1.5 text-[11px] font-medium transition-colors duration-500",
            s >= 5 ? "bg-primary-soft text-primary" : "bg-primary text-on-primary",
          )}
        >
          {s >= 5 ? "Saved ✓" : "Save brand"}
        </span>
      </Card>

      <span
        className={cn(
          "absolute top-[148px] left-[221px] z-10 grid h-[26px] w-[26px] place-items-center rounded-full border border-line bg-surface text-[11px] text-ink-soft shadow-sm",
          show(s >= 5),
        )}
      >
        →
      </span>

      <Card className="left-[252px] w-[204px]">
        <Doc
          title="Quarterly Report"
          logo={s >= 1}
          name={s >= 2}
          tint={s >= 3}
          brandFont={s >= 4}
        />
        <span
          className={cn(
            "absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-[#eaeee9] px-2 py-1 text-[9px] font-medium text-[#1F3D36]",
            show(s >= 6),
          )}
        >
          ✓ Brand applied
        </span>
      </Card>

      <Caption left={24}>Set once in Brand &amp; Styles</Caption>
      <Caption left={252}>Every new document starts here</Caption>
    </MiniStage>
  );
}

/* ── 2. Style: a document is read, a style assembles ─────────────────────── */

const styleTimeline: Timeline<Step> = [
  [0, { step: 0 }],
  [500, { step: 1 }],
  [1500, { step: 2 }],
  [2300, { step: 3 }],
  [3100, { step: 4 }],
  [4000, { step: 5 }],
  [5200, { step: 6 }],
];

export function StyleDemo({ paused }: { paused: boolean }) {
  const { scene, fade, ref } = useDemoLoop(styleTimeline, 9600, { step: 6 }, paused);
  const s = scene.step;
  const scanning = s >= 1 && s < 5;
  return (
    <MiniStage stageRef={ref} fade={fade} reset={s === 0}>
      {/* The uploaded document, being read. */}
      <Card className="left-6 w-[176px]">
        <Doc
          title="Q3 Report"
          logo
          name
          tint
          brandFont
          ring={{ title: s >= 2, body: s >= 3, table: s >= 4 }}
        />
        <span
          className="absolute inset-x-0 h-[26px] bg-gradient-to-b from-transparent"
          style={{
            top: s >= 1 ? "100%" : "-26px",
            opacity: scanning ? 1 : 0,
            transition: s >= 1 ? "top 3s linear, opacity 0.5s" : "none",
            borderBottom: `1.5px solid ${BRAND}`,
            backgroundImage: `linear-gradient(to bottom, transparent, rgba(31,61,54,0.14))`,
          }}
        />
      </Card>

      {/* Flow from document to style. */}
      <div
        className={cn(
          "absolute top-[147px] left-[204px] flex w-[40px] items-center text-primary",
          show(s >= 1),
        )}
      >
        <span
          className="h-[2px] flex-1 rounded-full"
          style={{ background: BRAND, opacity: 0.35 }}
        />
        <span className="-ml-px text-[10px] leading-none" style={{ color: BRAND }}>
          ▸
        </span>
      </div>

      {/* The style that assembles itself. */}
      <Card className="left-[248px] w-[208px] p-3.5">
        <div className="flex items-center justify-between">
          <Label>New style</Label>
          <span className={cn("h-1.5 w-1.5 rounded-full bg-ink-faint transition-opacity duration-500", scanning ? "animate-pulse opacity-100" : "opacity-40")} />
        </div>
        <p
          className="mt-1.5 h-[20px] text-[15px] leading-[20px] tracking-[-0.01em] text-ink"
          style={{ fontFamily: SERIF }}
        >
          {s >= 5 ? <Typed text={STYLE_NAME} /> : <span className="text-ink-faint">Reading document…</span>}
        </p>

        <div className="mt-3 space-y-2.5">
          <div className={show(s >= 2)}>
            <Label>Headings</Label>
            <p className="mt-1 flex items-baseline gap-3 leading-none" style={{ fontFamily: SERIF, color: BRAND }}>
              <span className="text-[17px] font-semibold">H1</span>
              <span className="text-[14px] font-semibold">H2</span>
              <span className="text-[11.5px] font-semibold">H3</span>
            </p>
          </div>
          <div className={show(s >= 3)}>
            <Label>Fonts &amp; colors</Label>
            <div className="mt-1 flex items-center gap-3">
              <span className="text-[20px] leading-none" style={{ fontFamily: SERIF, color: BRAND }}>Aa</span>
              <span className="text-[20px] leading-none text-ink-soft" style={{ fontFamily: SANS }}>Aa</span>
              <span className="ml-auto flex gap-1.5">
                {PALETTE.map((color) => (
                  <span key={color} className="h-3.5 w-3.5 rounded-full" style={{ background: color }} />
                ))}
              </span>
            </div>
          </div>
          <div className={show(s >= 4)}>
            <Label>Tables</Label>
            <div className="mt-1.5 overflow-hidden rounded-[3px] border border-line">
              <span className="block h-[7px]" style={{ background: BRAND }} />
              <span className="block h-[6px] border-b border-line" />
              <span className="block h-[6px]" />
            </div>
          </div>
        </div>

        <span
          className={cn(
            "absolute right-3.5 bottom-3 left-3.5 inline-flex items-center justify-center gap-1 rounded-[5px] bg-primary-soft py-1.5 text-[10px] font-medium text-primary",
            show(s >= 6),
          )}
        >
          ✓ Saved to My styles
        </span>
      </Card>

      <p className="absolute top-[304px] left-6 flex items-center gap-1.5 font-mono text-[9.5px] text-ink-faint">
        <DocGlyph className="h-2.5 w-2.5" />
        {FILE_NAME}
      </p>
      <Caption left={248}>Yours in every workspace</Caption>
    </MiniStage>
  );
}

/* ── 3. Use it: one sentence in the chat, the document restyles ──────────── */

const ASK_BEFORE = "Apply my ";
const ASK_AFTER = " style to this document.";
const ASK = ASK_BEFORE + STYLE_NAME + ASK_AFTER;

const askTimeline: Timeline<Typing> = (() => {
  const events: [number, Partial<Typing>][] = [[0, { step: 0, typed: 0 }]];
  for (let i = 1; i <= ASK.length; i++) events.push([600 + i * 45, { typed: i }]);
  events.push(
    [3300, { step: 1, typed: 0 }],
    [4000, { step: 2 }],
    [4800, { step: 3 }],
    [5900, { step: 4 }],
    [7000, { step: 5 }],
  );
  return events;
})();

const useRows = ["Found your style", "Restyled headings and tables", "Checked the result"];

export function UseDemo({ paused }: { paused: boolean }) {
  const { scene, fade, ref } = useDemoLoop(askTimeline, 10500, { step: 5, typed: 0 }, paused);
  const { step: s, typed } = scene;
  const styled = s >= 3;
  return (
    <MiniStage stageRef={ref} fade={fade} reset={s === 0 && typed === 0}>
      <Card className="left-6 w-[236px]">
        <div className="absolute inset-0">
          <Doc title="Operating Report" tint={false} brandFont={false} bodySans={false} />
        </div>
        <div
          className="absolute inset-0"
          style={{
            clipPath: styled ? "inset(0 0 0% 0)" : "inset(0 0 100% 0)",
            transition: styled ? "clip-path 1.8s cubic-bezier(0.6,0,0.3,1)" : "none",
          }}
        >
          <Doc title="Operating Report" tint brandFont bodySans />
        </div>
        <span
          className="absolute inset-x-0 h-[2px]"
          style={{
            top: styled ? "100%" : "0%",
            opacity: s >= 3 && s < 5 ? 1 : 0,
            background: BRAND,
            boxShadow: `0 0 10px 1px rgba(31,61,54,0.22)`,
            transition: styled ? "top 1.8s cubic-bezier(0.6,0,0.3,1), opacity 0.4s" : "none",
          }}
        />
        <span
          className={cn(
            "absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-[#eaeee9] px-2 py-1 text-[9px] font-medium text-[#1F3D36]",
            show(s >= 5),
          )}
        >
          ✓ {STYLE_NAME}
        </span>
      </Card>

      <Card className="left-[276px] flex w-[180px] flex-col">
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line px-3 text-[11px] font-medium text-ink">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Agent
        </div>
        <div className="flex flex-1 flex-col gap-2 overflow-hidden px-3 py-2.5">
          <div className={cn("rounded-[8px] bg-secondary-soft px-2 py-1.5 text-[9.5px] leading-[1.5] text-ink", show(s >= 1))}>
            {ASK_BEFORE}
            <span className="rounded-[3px] px-1 font-medium" style={{ background: "rgba(31,61,54,0.09)", color: BRAND }}>
              {STYLE_NAME}
            </span>
            {ASK_AFTER}
          </div>
          <ul className="flex flex-col gap-1.5">
            {useRows.map((row, i) => (
              <li key={row} className={cn("flex items-center gap-1.5 text-[9.5px] leading-[1.3] text-ink-soft", show(s >= i + 2))}>
                <svg viewBox="0 0 10 10" className="h-2 w-2 shrink-0 text-primary" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1.5 5.4 3.7 7.6 8.5 2.8" />
                </svg>
                {row}
              </li>
            ))}
          </ul>
          <p className={cn("text-[10px] leading-[1.4] font-medium text-ink", show(s >= 5))}>
            Done. Your words are untouched.
          </p>
        </div>
        <div className="m-2 mt-0 rounded-[8px] border border-line p-2">
          <div className="min-h-[36px] text-[9.5px] leading-[1.45] text-ink">
            {typed === 0 && s === 0 ? (
              <span className="text-ink-faint">Ask OpenSuite…</span>
            ) : (
              ASK.slice(0, typed)
            )}
            {typed > 0 ? <span className="ml-px inline-block h-[1em] w-px translate-y-[2px] animate-pulse bg-ink" /> : null}
          </div>
          <div className="flex justify-end">
            <span
              className={cn(
                "grid h-4 w-4 place-items-center rounded-[4px] text-[8px] transition-colors duration-500",
                typed >= ASK.length ? "bg-primary text-on-primary" : "bg-primary-soft text-ink-faint",
              )}
            >
              ➤
            </span>
          </div>
        </div>
      </Card>

      <p className="absolute top-[304px] left-6 flex items-center gap-1.5 font-mono text-[9.5px] text-ink-faint">
        <DocGlyph className="h-2.5 w-2.5" />
        Operating-Report.docx
      </p>
      <Caption left={276}>One sentence, no formatting work</Caption>
    </MiniStage>
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
