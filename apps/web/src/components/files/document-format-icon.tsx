import type { DocumentFormat } from "@/lib/api";
import { cn } from "@/lib/utils";

const SIZE = {
  sm: "h-3.5 w-3.5",
  md: "h-4 w-4",
} as const;

/**
 * Tiny shared format glyph for document lists/tabs.
 * Decorative when the filename already communicates type (`aria-hidden`).
 */
export function DocumentFormatIcon({
  format,
  size = "md",
  className,
  decorative = true,
}: {
  format: DocumentFormat;
  size?: keyof typeof SIZE;
  className?: string;
  /** When false, exposes an accessible name for the format. */
  decorative?: boolean;
}) {
  const label =
    format === "docx"
      ? "Word document"
      : format === "pptx"
        ? "Presentation"
        : "Spreadsheet";

  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      className={cn("shrink-0 text-ink-soft", SIZE[size], className)}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
    >
      {format === "docx" ? (
        <>
          <path
            d="M3.5 2.5h6.2L12.5 5.3V13a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinejoin="round"
          />
          <path
            d="M9.5 2.6V5.2H12"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinejoin="round"
          />
          <path
            d="M5 8h6M5 10.5h4.5"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
        </>
      ) : format === "pptx" ? (
        <>
          <rect
            x="2.5"
            y="3.5"
            width="11"
            height="8"
            rx="1.2"
            stroke="currentColor"
            strokeWidth="1.35"
          />
          <path
            d="M8 11.5v2M5.5 13.5h5"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
          />
          <path
            d="M5.5 6.2h5M5.5 8.3h3.5"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </>
      ) : (
        <>
          <rect
            x="2.5"
            y="2.5"
            width="11"
            height="11"
            rx="1.2"
            stroke="currentColor"
            strokeWidth="1.35"
          />
          <path
            d="M2.5 6h11M2.5 10h11M6.5 2.5v11"
            stroke="currentColor"
            strokeWidth="1.25"
          />
        </>
      )}
    </svg>
  );
}
