import Link from "next/link";
import type { ReactNode } from "react";

import { GitHubMark } from "@/components/marketing/github-mark";
import { ProductPreview } from "@/components/marketing/product-preview";
import { SiteButton } from "@/components/marketing/site-button";
import { SiteShell } from "@/components/marketing/site-shell";
import {
  CLONE_COMMAND,
  CONTRIBUTING_URL,
  ENGINE_GITHUB_URL,
  GITHUB_URL,
} from "@/lib/site";
import { isSignupAllowed } from "@/lib/signup";

const heroFacts = ["MIT licensed", "Self-hostable", "Bring your own model key"];

const runSteps = [
  {
    name: "Understand",
    body: "OpenSuite reads the document's real structure — headings, paragraphs, tables, and the styles already in use.",
    annotation: "document.inspect",
  },
  {
    name: "Locate",
    body: "It resolves the exact cells and sentences carrying August's figures by selector, rather than by guessing at text.",
    annotation: "document.find",
  },
  {
    name: "Edit",
    body: "Typed operations replace those values in place, batched so related changes land together or not at all.",
    annotation: "batch replace",
  },
  {
    name: "Preserve",
    body: "Anything the request didn't mention — styles, numbering, headers, unsupported parts — is left as it was.",
    annotation: "source-aware",
  },
  {
    name: "Verify",
    body: "The saved file is inspected again for what usually breaks: stale periods, broken totals, leftover placeholders.",
    annotation: "post-save checks",
  },
  {
    name: "Save",
    body: "The run ends as one new immutable version, sitting alongside the six before it.",
    annotation: "version 7",
  },
];

const principles = [
  {
    title: "Real files, not prose",
    body: "Your .docx is opened as a document, not pasted into a prompt as flattened text. Structure survives the round trip.",
  },
  {
    title: "Typed operations only",
    body: "Every change is a named operation the engine knows how to perform. No freeform XML editing, no shell, no filesystem.",
  },
  {
    title: "Preservation first",
    body: "The engine is source-aware. What it doesn't support, and what you didn't ask about, is left alone instead of regenerated.",
  },
  {
    title: "One run, one version",
    body: "A run writes once. History stays short and readable, and going back is a version away rather than a conversation away.",
  },
];

const pipeline = [
  "web",
  "API",
  "agent runtime",
  "engine client",
  "opensuite-engine",
];

const working = [
  "Open, create, edit, download, and version DOCX files in workspaces",
  "Ask the agent to inspect structure and make targeted edits",
  "Text, paragraphs, basic formatting, tables, and selected DOCX structure",
  "Your own OpenAI, Anthropic, or OpenRouter key — or a server-managed provider",
  "Run the application and its document engine on your own infrastructure",
];

const notYet = [
  "Slides and Sheets editing — PPTX and XLSX can be stored, not edited",
  "Full fidelity on complex or unusual source documents",
  "Self-service account and data deletion",
  "A one-command local stack — Postgres, S3, and email are yours to provide",
];

const repoLinks = [
  { label: "Application repository", href: GITHUB_URL, meta: "TypeScript" },
  { label: "Document engine", href: ENGINE_GITHUB_URL, meta: "Rust" },
  { label: "Contributing guide", href: CONTRIBUTING_URL, meta: "CONTRIBUTING.md" },
];

export function LandingPage() {
  const startHref = isSignupAllowed() ? "/sign-up" : "/sign-in";

  return (
    <SiteShell>
      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="os-container pt-16 pb-14 sm:pt-24 sm:pb-16">
        <p className="os-label">Open source · DOCX · Alpha</p>
        <h1 className="os-display mt-6 max-w-[15em] text-[36px] leading-[1.06] sm:text-[48px] lg:text-[56px]">
          An agent that edits the document, not a copy of it.
        </h1>
        <p className="os-lead mt-7 max-w-[52ch]">
          OpenSuite opens your real .docx, reads its structure, and makes the
          change you asked for through typed operations in a deterministic
          document engine. What you didn&apos;t ask about stays exactly as it
          was.
        </p>

        <div className="mt-9 flex flex-wrap items-center gap-3">
          <SiteButton href={startHref}>Try OpenSuite</SiteButton>
          <SiteButton href={GITHUB_URL} variant="outline" external>
            <GitHubMark className="h-4 w-4" />
            Read the source
          </SiteButton>
        </div>

        <ul className="mt-12 flex flex-col gap-2.5 border-t border-line pt-5 sm:flex-row sm:items-center sm:gap-0">
          {heroFacts.map((fact, index) => (
            <li
              key={fact}
              className={
                "os-label " +
                (index === 0 ? "sm:pr-6" : "sm:border-l sm:border-line sm:px-6")
              }
            >
              {fact}
            </li>
          ))}
        </ul>
      </section>

      {/* ── Product visual ─────────────────────────────────────────────── */}
      <section id="workspace" className="os-container scroll-mt-24 pb-20 sm:pb-24">
        <figure>
          <ProductPreview />
          <figcaption className="mt-4 flex flex-col justify-between gap-1 os-annot sm:flex-row">
            <span>
              Fig. 1 — The workspace: file explorer, the open DOCX, and the
              agent panel that ran the change.
            </span>
            <span className="shrink-0">Interface reconstruction</span>
          </figcaption>
        </figure>
      </section>

      {/* ── 01 · A real run ────────────────────────────────────────────── */}
      <Section
        id="run"
        index="01"
        label="A real run"
        title="Update a report without disturbing the rest of it."
        lead="One request, start to finish. Each stage is visible while it happens, and the run ends as a single new version you can read or roll back."
      >
        <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-5">
            <div className="rounded-[5px] border border-[var(--rule)] bg-surface p-5">
              <div className="flex items-center gap-2 os-annot">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Monthly-Report.docx
              </div>
              <p className="mt-4 text-[16.5px] leading-[1.5] text-ink">
                “Update this monthly report with the September numbers.”
              </p>
              <div className="mt-5 flex items-center justify-between border-t border-line pt-3 os-annot">
                <span>agent · run 7</span>
                <span>19s</span>
              </div>
            </div>
            <p className="os-body mt-5 max-w-[40ch] text-[14.5px]">
              The file never leaves the workspace and is never rewritten from
              scratch. The agent asks the engine questions about it, then asks
              for specific changes.
            </p>
          </div>

          <ol className="border-t border-line lg:col-span-7">
            {runSteps.map((step, index) => (
              <li
                key={step.name}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-4 border-b border-line py-5 sm:grid-cols-[2.25rem_minmax(0,1fr)_9rem]"
              >
                <span className="os-label pt-1">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
                    {step.name}
                  </h3>
                  <p className="mt-1.5 text-[14px] leading-[1.6] text-ink-soft">
                    {step.body}
                  </p>
                </div>
                <span className="col-start-2 mt-2 os-annot sm:col-start-3 sm:mt-0 sm:pt-1 sm:text-right">
                  {step.annotation}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      {/* ── 02 · Principles ────────────────────────────────────────────── */}
      <Section
        id="principles"
        index="02"
        label="Principles"
        title="Why it behaves differently."
        lead="Four decisions do most of the work. They are the reason a change on page nine doesn't quietly reformat page one."
      >
        <div className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-2">
          {principles.map((principle, index) => (
            <div key={principle.title} className="border-t border-[var(--rule)] pt-5">
              <div className="flex items-baseline gap-3">
                <span className="os-label text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className="text-[16px] font-medium tracking-[-0.01em] text-ink">
                  {principle.title}
                </h3>
              </div>
              <p className="mt-2.5 max-w-[44ch] text-[14.5px] leading-[1.65] text-ink-soft">
                {principle.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 03 · Architecture ──────────────────────────────────────────── */}
      <Section
        id="architecture"
        index="03"
        label="Architecture"
        title="Where the work actually happens."
        lead="Two repositories, one boundary. Document behaviour stays deterministic because exactly one component is allowed to touch a file."
      >
        <div className="mt-11 overflow-x-auto border-y border-[var(--rule)] py-5">
          <ol className="flex min-w-max items-center gap-3 os-annot text-[12.5px]">
            {pipeline.map((node, index) => (
              <li key={node} className="flex items-center gap-3">
                {index > 0 ? (
                  <span className="text-[var(--rule)]" aria-hidden="true">
                    →
                  </span>
                ) : null}
                <span
                  className={
                    index === pipeline.length - 1
                      ? "font-medium text-primary"
                      : "text-ink-soft"
                  }
                >
                  {node}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-10 grid gap-10 sm:grid-cols-2 sm:gap-12">
          <div>
            <h3 className="os-label">This repository</h3>
            <p className="mt-3.5 max-w-[46ch] text-[14.5px] leading-[1.65] text-ink-soft">
              Accounts, workspaces, object storage, immutable document
              versions, agent threads and runs, and the web app. It never
              parses or edits Office XML itself.
            </p>
          </div>
          <div>
            <h3 className="os-label">opensuite-engine</h3>
            <p className="mt-3.5 max-w-[46ch] text-[14.5px] leading-[1.65] text-ink-soft">
              A separate Rust project that parses DOCX, resolves targets,
              performs supported mutations, and returns diagnostics. Changing
              the model changes nothing about how a file is written.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 04 · Scope ─────────────────────────────────────────────────── */}
      <Section
        id="scope"
        index="04"
        label="Scope today"
        title="What works, and what doesn't yet."
        lead="OpenSuite is alpha. The honest version of the feature list is more useful to you than a longer one."
      >
        <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-14">
          <div>
            <h3 className="os-label">Working now</h3>
            <ul className="mt-4 border-t border-line">
              {working.map((item) => (
                <li
                  key={item}
                  className="flex gap-3 border-b border-line py-3.5 text-[14.5px] leading-[1.6] text-ink-soft"
                >
                  <CheckGlyph className="mt-[7px] h-2.5 w-2.5 shrink-0 text-primary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="os-label">Not yet</h3>
            <ul className="mt-4 border-t border-line">
              {notYet.map((item) => (
                <li
                  key={item}
                  className="flex gap-3 border-b border-line py-3.5 text-[14.5px] leading-[1.6] text-ink-faint"
                >
                  <span
                    className="mt-[11px] h-px w-2.5 shrink-0 bg-[var(--rule)]"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <p className="mt-10 max-w-[62ch] border-l-2 border-primary pl-5 text-[14.5px] leading-[1.65] text-ink">
          DOCX fidelity varies with the source file and the operation. Test
          documents that matter before relying on the result.
        </p>
      </Section>

      {/* ── 05 · Open source ───────────────────────────────────────────── */}
      <Section
        id="open-source"
        index="05"
        label="Open source"
        title="Built in public, MIT licensed."
        lead="Read exactly how a document is inspected and changed, run the whole thing on your own machines, or send a patch."
      >
        <div className="mt-12 grid gap-12 lg:grid-cols-12 lg:gap-14">
          <div className="lg:col-span-7">
            <p className="os-body max-w-[54ch]">
              The application and the document engine are separate public
              repositories with a deliberate boundary between them. Nothing
              about how a file is parsed or written is hidden behind a hosted
              service.
            </p>
            <pre className="mt-7 overflow-x-auto rounded-[4px] border border-line bg-sunken px-4 py-3.5 text-[12.5px] leading-relaxed text-ink">
              <code className="font-mono">
                <span className="select-none text-ink-faint">$ </span>
                {CLONE_COMMAND}
              </code>
            </pre>
            <p className="mt-5 max-w-[54ch] text-[14px] leading-[1.6] text-ink-faint">
              Self-hosting needs PostgreSQL, S3-compatible storage, and an
              email provider. There is no one-command local stack yet, and the
              README says so too.
            </p>
          </div>

          <ul className="border-t border-[var(--rule)] lg:col-span-5">
            {repoLinks.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="group flex items-baseline justify-between gap-4 border-b border-line py-4 transition-colors"
                >
                  <span className="text-[14.5px] text-ink transition-colors group-hover:text-primary">
                    {link.label}
                  </span>
                  <span className="os-annot shrink-0">
                    {link.meta}
                    <span aria-hidden="true" className="pl-2">
                      ↗
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-4 border-b border-line py-4">
              <span className="text-[14.5px] text-ink-soft">License</span>
              <span className="os-annot shrink-0">MIT</span>
            </li>
          </ul>
        </div>
      </Section>

      {/* ── Close ──────────────────────────────────────────────────────── */}
      <section className="border-t border-line">
        <div className="os-container flex flex-col gap-8 py-20 sm:py-24 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="os-display text-[28px] leading-[1.15] sm:text-[34px]">
              Bring a document you actually use.
            </h2>
            <p className="os-body mt-4 max-w-[46ch]">
              Open a .docx, ask for one change, and read exactly what the agent
              did to it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SiteButton href={startHref}>Try OpenSuite</SiteButton>
            <SiteButton href={GITHUB_URL} variant="outline" external>
              <GitHubMark className="h-4 w-4" />
              GitHub
            </SiteButton>
          </div>
        </div>
      </section>
    </SiteShell>
  );
}

/**
 * Every landing section shares one header rhythm: mono index and label, a
 * serif statement, then a lead paragraph — all left-aligned to the page grid.
 * Variety comes from the content below, not from re-centring headers.
 */
function Section({
  id,
  index,
  label,
  title,
  lead,
  children,
}: {
  id: string;
  index: string;
  label: string;
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-line">
      <div className="os-container py-20 sm:py-24">
        <p className="os-label">
          <span className="text-primary">{index}</span>
          <span aria-hidden="true" className="px-2.5 text-[var(--rule)]">
            /
          </span>
          {label}
        </p>
        <h2 className="os-display mt-5 max-w-[24ch] text-[26px] leading-[1.15] sm:text-[32px]">
          {title}
        </h2>
        <p className="os-lead mt-4 max-w-[54ch] text-[16px] sm:text-[16.5px]">
          {lead}
        </p>
        {children}
      </div>
    </section>
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
