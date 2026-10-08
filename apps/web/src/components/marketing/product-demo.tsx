"use client";

import Link from "next/link";
import { useState } from "react";

import {
  DemoCursor,
  DemoWorkspace,
} from "@/components/marketing/product-demo-ui";
import {
  LOOP_MS,
  POSTER,
  TIMELINE,
  cameraTransform,
  chapters,
} from "@/components/marketing/product-demo-scene";
import { useDemoLoop } from "@/components/marketing/use-demo-loop";

/** Warm paper backdrop with a faint brand glow; only the site's own palette. */
const BACKDROP =
  "radial-gradient(55% 70% at 100% 0%, color-mix(in srgb, var(--primary) 11%, transparent), transparent 70%), radial-gradient(60% 70% at 0% 100%, color-mix(in srgb, var(--primary) 6%, transparent), transparent 70%), radial-gradient(70% 60% at 10% 0%, rgba(255,255,255,0.75), transparent 70%), var(--canvas)";

/**
 * Landing figure: a looping, camera-driven mock of the real workspace —
 * prompt, run, tracked-change review, version restore. Server render and
 * prefers-reduced-motion show a still frame (the review moment); the loop
 * only runs while the figure is on screen and not paused.
 */
export function ProductDemo() {
  const [paused, setPaused] = useState(false);
  const { scene, fade, ref } = useDemoLoop(TIMELINE, LOOP_MS, POSTER, paused);

  return (
    <figure>
      <div
        ref={ref}
        aria-hidden="true"
        className="pd-frame relative overflow-hidden rounded-[10px] border border-[var(--rule)] shadow-[0_1px_1px_rgba(25,25,23,0.03),0_24px_60px_-34px_rgba(25,25,23,0.28)]"
        style={{ background: BACKDROP }}
      >
        <div className="pd-scale">
          {/* The workspace floats on the backdrop; the camera moves inside it. */}
          <div className="absolute top-[30px] left-10 h-[580px] w-[1000px] overflow-hidden rounded-[8px] bg-surface shadow-[0_2px_4px_rgba(25,25,23,0.05),0_36px_80px_-34px_rgba(25,25,23,0.45)] ring-1 ring-[var(--rule)]">
            <div
              className="pd-cam"
              style={{
                transform: cameraTransform(scene.cam),
                opacity: fade ? 0 : 1,
              }}
            >
              <DemoWorkspace s={scene} />
              <DemoCursor s={scene} />
            </div>
          </div>
        </div>
      </div>

      <ol className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 md:grid-cols-5">
        {chapters.map((chapter, i) => {
          const reached = scene.chapter >= i;
          return (
            <li key={chapter.name} className="relative pt-3">
              <span className="absolute inset-x-0 top-0 h-px bg-line" />
              <span
                className="absolute inset-x-0 top-0 h-px origin-left bg-primary transition-transform duration-700"
                style={{ transform: `scaleX(${reached ? 1 : 0})` }}
              />
              <span
                className={
                  "block transition-colors duration-500 " +
                  (scene.chapter === i ? "text-ink" : "text-ink-faint")
                }
              >
                <span className="os-label mr-2 text-[10px] text-primary">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-[13px] font-medium tracking-[-0.01em]">
                  {chapter.name}
                </span>
              </span>
              <span className="os-annot mt-1 block text-[11px]">{chapter.note}</span>
            </li>
          );
        })}
      </ol>

      <figcaption className="mt-5 flex flex-col justify-between gap-1 os-annot sm:flex-row sm:items-baseline">
        <span>
          Fig. 1 — The workspace: prompt the agent, review its tracked changes,
          keep editing by hand with the full toolbar, and restore any earlier
          version.
        </span>
        <span className="flex shrink-0 items-baseline gap-4 text-[12px]">
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="cursor-pointer text-secondary transition-colors hover:text-primary motion-reduce:hidden"
          >
            {paused ? "Play" : "Pause"}
          </button>
          <Link
            href="/product"
            className="text-secondary transition-colors hover:text-primary"
          >
            Product details →
          </Link>
        </span>
      </figcaption>
    </figure>
  );
}
