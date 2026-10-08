import type { ReactNode } from "react";
import Link from "next/link";

import { MarketingClose } from "@/components/marketing/marketing-close";
import {
  CheckGlyph,
  PageSection,
} from "@/components/marketing/page-section";
import { ProductPreview } from "@/components/marketing/product-preview";
import { SiteShell } from "@/components/marketing/site-shell";
import {
  CLONE_COMMAND,
  CONTRIBUTING_URL,
  ENGINE_GITHUB_URL,
  GITHUB_URL,
} from "@/lib/site";

/** One vertical content row: title on the left, short text on the right. */
function Row({
  index,
  title,
  children,
}: {
  index?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-3 border-t border-line py-7 lg:grid-cols-12 lg:gap-12">
      <h2 className="flex items-baseline gap-3 text-[16px] font-medium tracking-[-0.01em] text-ink lg:col-span-4">
        {index ? <span className="os-label text-primary">{index}</span> : null}
        {title}
      </h2>
      <div className="max-w-[58ch] text-[14.5px] leading-[1.65] text-ink-soft lg:col-span-8">
        {children}
      </div>
    </div>
  );
}

const productRows = [
  {
    title: "Files live in workspaces",
    body: "Create a blank document or upload a .docx, and open it in a tabbed workspace. Star, search, and trash files — trashed files stay restorable until you empty the trash — and download the .docx whenever you want.",
  },
  {
    title: "Edit it yourself, or ask",
    body: "The editor is a normal word processor. The agent panel sits beside it: describe a change, @-tag other files in the workspace if they matter, and watch each step appear as it runs. The document updates while the agent works, and an ambiguous request gets a question instead of a guess.",
  },
  {
    title: "Every run is a version",
    body: "Agent changes land as one new version. The explorer keeps the latest five versions of the open document: open an older one read-only, or restore it as current. Restoring discards the newer versions, and you confirm first.",
  },
  {
    title: "Your brand and your styles",
    body: "Save your organization's logo, colors, and fonts per workspace, and styles learned from documents you trust to your account. The agent uses them when it creates a document or when you ask.",
  },
  {
    title: "Your model",
    body: "Connect your own OpenAI, Anthropic, or OpenRouter key in Settings, or use a provider your operator configured on the server.",
  },
];

const agentCanDo = [
  { name: "Text and formatting", note: "find, replace, insert, restyle" },
  { name: "Tables", note: "cells, rows, columns, shading, widths" },
  { name: "Word styles", note: "apply, create, update" },
  { name: "Page layout", note: "sections, headers, footers, page numbers" },
  { name: "Tables of contents and fields", note: "refreshed with LibreOffice" },
  { name: "Comments", note: "simple selections in one paragraph" },
  { name: "Tracked changes", note: "insert, delete, replace, accept, reject" },
  { name: "Footnotes and endnotes", note: "simple notes" },
  { name: "Images", note: "PNG or JPEG from your workspace" },
];

const runSteps = [
  {
    name: "Understand",
    body: "OpenSuite reads the document's real structure — headings, paragraphs, tables, and the styles already in use — plus any other workspace file you tag or name.",
    annotation: "document.inspect",
  },
  {
    name: "Locate",
    body: "It finds the exact passages, cells, or headings your request pointed at — by structure, not by guessing at wording. If it can't tell which one you mean, it asks you.",
    annotation: "document.find",
  },
  {
    name: "Edit",
    body: "Typed operations apply the changes in place, batched so related edits land together. You see the document update while the run is in progress.",
    annotation: "batch replace",
  },
  {
    name: "Preserve",
    body: "Anything you didn't mention — layout, numbering, headers, unsupported parts — stays as it was.",
    annotation: "source-aware",
  },
  {
    name: "Verify",
    body: "The result is checked again for what usually breaks: table totals that stop adding up, leftover placeholders, lost fields, malformed comments or notes. A blocking problem fails the run instead of passing quietly.",
    annotation: "post-save checks",
  },
  {
    name: "Save",
    body: "A run that changed the document ends as one new immutable version, alongside whatever came before. Any of the latest five can be restored from the explorer.",
    annotation: "one version",
  },
];

const whenStuck = [
  {
    title: "It needs an answer",
    body: "If a request genuinely has two readings, the agent stops and asks instead of guessing. It marks the thread “Needs your input”, and your reply starts a new run in the same thread.",
  },
  {
    title: "It runs out of room",
    body: "A long request can hit a turn or time limit. Use Continue to pick up where it stopped.",
  },
  {
    title: "A check fails",
    body: "If verification finds a blocking problem, the run ends as failed rather than as a success with a warning attached.",
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
  "Ask the agent to inspect a document and make targeted edits to text, formatting, and tables",
  "Styles, sections, headers and footers, page numbers, and tables of contents",
  "Comments, tracked changes, footnotes and endnotes in simple cases",
  "Insert and replace PNG or JPEG images from your workspace, including your brand logo",
  "Save your brand, learn styles from documents, and apply them by name",
  "Your own OpenAI, Anthropic, or OpenRouter key — or a server-managed provider",
  "Run the application and its document engine on your own infrastructure",
];

const notYet = [
  "Slides and Sheets editing — PPTX and XLSX can be stored, not edited",
  "Full fidelity on complex or unusual source documents",
  "Threaded comment replies, and notes or tracked changes in complex structures like tables",
  "Attaching images in chat, web search, and external connectors",
  "Self-service account and data deletion",
  "A one-command local stack — Postgres, S3, and email are yours to provide",
];

const repoLinks = [
  { label: "Application repository", href: GITHUB_URL, meta: "TypeScript" },
  { label: "Document engine", href: ENGINE_GITHUB_URL, meta: "Rust" },
  { label: "Contributing guide", href: CONTRIBUTING_URL, meta: "CONTRIBUTING.md" },
];

export function ProductPage() {
  return (
    <SiteShell>
      <PageSection
        index="01"
        label="Product"
        title="The workspace where the document stays the document."
        lead="A file explorer, a DOCX editor, and an agent panel on one screen. The agent edits the file you have open and leaves a version behind."
      >
        <figure className="mt-12">
          <ProductPreview />
          <figcaption className="mt-4 flex flex-col justify-between gap-1 os-annot sm:flex-row">
            <span>
              Fig. 1 — Monthly-Report.docx after a September update run.
            </span>
            <span className="shrink-0">Interface reconstruction</span>
          </figcaption>
        </figure>

        <div className="mt-14 border-b border-line">
          {productRows.map((row) => (
            <Row key={row.title} title={row.title}>
              {row.body}
            </Row>
          ))}
          <Row title="What the agent can work with">
            <ul>
              {agentCanDo.map((item) => (
                <li
                  key={item.name}
                  className="flex items-baseline justify-between gap-4 border-b border-line py-2 first:pt-0 last:border-b-0 last:pb-0"
                >
                  <span className="text-ink">{item.name}</span>
                  <span className="os-annot text-right">{item.note}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-[13.5px] text-ink-faint">
              Known limits are listed on{" "}
              <Link
                href="/scope"
                className="text-primary underline-offset-2 hover:underline"
              >
                Scope today
              </Link>
              .
            </p>
          </Row>
        </div>
      </PageSection>
      <MarketingClose />
    </SiteShell>
  );
}

export function HowItWorksPage() {
  return (
    <SiteShell>
      <PageSection
        index="02"
        label="A real run"
        title="Ask for a change. Keep the rest of the document."
        lead="One request, start to finish — a brief, a draft, a syllabus, a proposal, a report. Each stage is visible while it happens, and the run ends as a single new version you can read or roll back."
      >
        <div className="mt-12 grid gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-5">
            <div className="rounded-[5px] border border-[var(--rule)] bg-surface p-5">
              <div className="flex items-center gap-2 os-annot">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                Your-Document.docx
              </div>
              <p className="mt-4 text-[16.5px] leading-[1.5] text-ink">
                “Update this with the latest notes and leave everything else
                alone.”
              </p>
              <div className="mt-5 flex items-center justify-between border-t border-line pt-3 os-annot">
                <span>agent · one run</span>
                <span className="text-secondary">saved</span>
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
                <span className="os-label pt-1 text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div>
                  <h2 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
                    {step.name}
                  </h2>
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

        <h2 className="os-label mt-16">When it can&apos;t just finish</h2>
        <div className="mt-4 border-b border-line">
          {whenStuck.map((item) => (
            <Row key={item.title} title={item.title}>
              {item.body}
            </Row>
          ))}
        </div>
      </PageSection>
      <MarketingClose />
    </SiteShell>
  );
}

export function PrinciplesPage() {
  return (
    <SiteShell>
      <PageSection
        index="03"
        label="Principles"
        title="Why it behaves differently."
        lead="Four decisions do most of the work. They are the reason a change on page nine doesn't quietly reformat page one."
      >
        <div className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-2">
          {principles.map((principle, index) => (
            <div
              key={principle.title}
              className="border-t border-[var(--rule)] pt-5"
            >
              <div className="flex items-baseline gap-3">
                <span className="os-label text-primary">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h2 className="text-[16px] font-medium tracking-[-0.01em] text-ink">
                  {principle.title}
                </h2>
              </div>
              <p className="mt-2.5 max-w-[44ch] text-[14.5px] leading-[1.65] text-ink-soft">
                {principle.body}
              </p>
            </div>
          ))}
        </div>
      </PageSection>
      <MarketingClose />
    </SiteShell>
  );
}

export function ArchitecturePage() {
  return (
    <SiteShell>
      <PageSection
        index="04"
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
                      : index === 0
                        ? "text-secondary"
                        : "text-ink-soft"
                  }
                >
                  {node}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mt-10 border-b border-line">
          <Row title="Web app and API">
            Accounts, workspaces, object storage, immutable document versions,
            agent threads and runs, and the editor. The API never parses or
            edits Office XML itself.
          </Row>
          <Row title="Agent runtime">
            A generic model-and-tools loop that knows nothing about Office
            files. The API hands it a small set of typed document tools,
            loaded as the request needs them — no shell, no filesystem.
          </Row>
          <Row title="opensuite-engine">
            A separate Rust project that parses DOCX, resolves targets,
            performs supported mutations, and returns diagnostics. It ships as
            a native package, so changing the model changes nothing about how
            a file is written.
          </Row>
        </div>
      </PageSection>
      <MarketingClose />
    </SiteShell>
  );
}

export function ScopePage() {
  return (
    <SiteShell>
      <PageSection
        index="05"
        label="Scope today"
        title="What works, and what doesn't yet."
        lead="OpenSuite is alpha. The honest version of the feature list is more useful to you than a longer one."
      >
        <div className="mt-12 grid gap-10 lg:grid-cols-2 lg:gap-14">
          <div>
            <h2 className="os-label">
              <span className="text-primary">Working now</span>
            </h2>
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
            <h2 className="os-label">Not yet</h2>
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
          DOCX fidelity varies with the source file and the operation. Newer
          features such as comments, tracked changes, and notes have been
          checked against LibreOffice; review in Word and Google Docs is still
          pending. Test documents that matter before relying on the result.
        </p>
      </PageSection>
      <MarketingClose />
    </SiteShell>
  );
}

export function OpenSourcePage() {
  return (
    <SiteShell>
      <PageSection
        index="06"
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
                <span className="select-none text-secondary">$ </span>
                {CLONE_COMMAND}
              </code>
            </pre>
            <p className="mt-5 max-w-[54ch] text-[14px] leading-[1.6] text-ink-faint">
              Self-hosting needs PostgreSQL, S3-compatible storage, and an
              email provider (Resend). Refreshing tables of contents and page
              fields also uses LibreOffice, which the Docker image includes.
              There is no one-command local stack yet, and the README says so
              too.
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
                    <span aria-hidden="true" className="pl-2 text-secondary">
                      ↗
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            <li className="flex items-baseline justify-between gap-4 border-b border-line py-4">
              <span className="text-[14.5px] text-ink-soft">License</span>
              <span className="os-annot shrink-0 text-primary">MIT</span>
            </li>
          </ul>
        </div>
      </PageSection>
      <MarketingClose />
    </SiteShell>
  );
}
