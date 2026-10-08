"use client";

import { useState } from "react";

import {
  BrandDemo,
  StyleDemo,
  UseDemo,
} from "@/components/marketing/brand-style-demos";
import { cn } from "@/lib/utils";

const items = [
  {
    Demo: BrandDemo,
    title: "Set your brand once",
    body: "Add your logo, colors, and fonts in Brand & Styles. When the agent creates a new report or proposal, it starts in your fonts and colors, and adds your logo. Say “don’t use our branding” and it skips all of it.",
    note: "Brand & Styles → Brand",
  },
  {
    Demo: StyleDemo,
    title: "Learn a style from a document",
    body: "Upload a .docx you like. OpenSuite reads its fonts, heading levels, and table treatment and saves them as a personal style that follows you across workspaces.",
    note: "Saved Styles → Learn from a document",
  },
  {
    Demo: UseDemo,
    title: "Apply it from the chat",
    body: "Ask the agent to apply a saved style by name. The formatting changes; the words and structure stay exactly as written.",
    note: "“Apply my … style to this document”",
  },
];

/**
 * Three illustrated steps, one per row, alternating sides. Text and
 * illustration always sit next to each other so the eye does not travel.
 */
export function BrandStyleSection() {
  const [paused, setPaused] = useState(false);

  return (
    <section className="os-container pb-8 sm:pb-12">
      <div className="border-t border-[var(--rule)] pt-14 sm:pt-16">
        <div className="flex items-baseline justify-between gap-4">
          <p className="os-label">
            <span className="text-primary">Brand</span>
            <span aria-hidden="true" className="px-2.5 text-[var(--rule)]">
              /
            </span>
            Styles
          </p>
          <button
            type="button"
            onClick={() => setPaused((p) => !p)}
            className="os-annot cursor-pointer text-[12px] text-secondary transition-colors hover:text-primary motion-reduce:hidden"
          >
            {paused ? "Play" : "Pause"}
          </button>
        </div>
        <h2 className="os-display mt-5 max-w-[24ch] text-[26px] leading-[1.15] sm:text-[32px]">
          Documents that already look like yours.
        </h2>
        <p className="os-lead mt-4 max-w-[56ch] text-[16px] sm:text-[16.5px]">
          Save your brand and the styles of documents you trust, then let the
          agent use them — when you create a document or when you ask.
        </p>

        <ol className="mt-12">
          {items.map(({ Demo, title, body, note }, index) => {
            const flip = index % 2 === 1;
            return (
              <li
                key={title}
                className="grid items-center gap-8 border-t border-line py-10 first:border-t-0 first:pt-2 lg:grid-cols-12 lg:gap-14 lg:py-14"
              >
                <div className={cn("lg:col-span-5", flip && "lg:col-start-8")}>
                  <span className="os-label text-primary">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3 className="mt-3 text-[20px] font-medium tracking-[-0.01em] text-ink">
                    {title}
                  </h3>
                  <p className="mt-3 max-w-[42ch] text-[15px] leading-[1.7] text-ink-soft">
                    {body}
                  </p>
                  <p className="os-annot mt-5 text-[12px]">{note}</p>
                </div>
                <div
                  className={cn(
                    "w-full max-w-[600px] lg:col-span-7 lg:row-start-1",
                    flip
                      ? "lg:col-start-1 lg:justify-self-start"
                      : "lg:col-start-6 lg:justify-self-end",
                  )}
                >
                  <Demo paused={paused} />
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
