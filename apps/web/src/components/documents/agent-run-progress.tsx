"use client";

import {
  detailsAffordanceLabel,
  progressMarker,
  type AgentProgressLine,
  type AgentRunPresentation,
} from "@/lib/agent-progress";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

/** Professional run progress: semantic milestones by default, tool trace on demand. */
export function AgentRunProgress({
  presentation,
  status,
  totalElapsed,
  expanded,
  onToggle,
  live = false,
}: {
  presentation: AgentRunPresentation;
  status: AgentProgressLine["status"];
  totalElapsed?: string | null;
  expanded: boolean;
  onToggle: () => void;
  live?: boolean;
}) {
  const isActive = status === "active" || live;
  const hasDetails = presentation.actionCount > 0;
  const detailsLabel = expanded
    ? "Hide details"
    : detailsAffordanceLabel(presentation.actionCount);

  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex max-w-full items-center gap-1.5 text-[length:var(--text-xs)] leading-[1.4]",
          status === "error"
            ? "text-danger"
            : isActive
              ? "text-ink"
              : "text-ink-faint",
        )}
      >
        {isActive ? (
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-35" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
        ) : status === "error" ? (
          <span className="shrink-0 text-[length:var(--text-2xs)]" aria-hidden>
            !
          </span>
        ) : (
          <span className="shrink-0 text-[length:var(--text-2xs)]" aria-hidden>
            ✓
          </span>
        )}
        <span className="min-w-0 truncate font-medium">
          {presentation.headline}
        </span>
        {totalElapsed && isActive ? (
          <span className="shrink-0 tabular-nums text-[length:var(--text-2xs)] text-ink-faint">
            {totalElapsed}
          </span>
        ) : null}
      </div>

      {isActive && presentation.activities.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5 pl-3.5" aria-label="Run progress">
          {presentation.activities.map((activity) => (
            <li
              key={activity.family}
              className={cn(
                "flex items-baseline gap-1.5 text-[length:var(--text-2xs)] leading-[1.45]",
                activity.status === "error"
                  ? "text-danger"
                  : activity.status === "active"
                    ? "text-ink-soft"
                    : "text-ink-faint",
              )}
            >
              <span className="w-2.5 shrink-0 tabular-nums opacity-80" aria-hidden>
                {progressMarker(activity.status)}
              </span>
              <span className="min-w-0 truncate">
                {activity.label}
                {activity.status === "done" &&
                activity.changeCount > 1 &&
                activity.countNoun ? (
                  <span className="opacity-70">
                    {" "}
                    · {activity.changeCount} {activity.countNoun}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {hasDetails ? (
        <div className="mt-1 pl-3.5">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className={cn(
              focusRingClass,
              "rounded-[var(--radius-sm)] py-0.5 text-left text-[length:var(--text-2xs)] text-ink-faint transition-colors hover:text-primary",
            )}
          >
            {detailsLabel}
          </button>
          {expanded ? (
            <div className="mt-1 space-y-0.5 border-l border-line pl-2.5">
              {presentation.details.map((group, index) => (
                <div
                  key={`${group.key}:${index}`}
                  className={cn(
                    "flex items-baseline gap-2 py-px text-[length:var(--text-2xs)] leading-[1.4]",
                    group.recovered
                      ? "text-ink-faint"
                      : group.status === "error"
                        ? "text-danger"
                        : group.status === "active"
                          ? "text-ink-soft"
                          : "text-ink-faint",
                  )}
                >
                  {group.recovered ? (
                    <span
                      className="shrink-0 text-[length:var(--text-2xs)] text-accent opacity-70"
                      aria-hidden
                    >
                      ↻
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate">
                    {group.label}
                    {group.count > 1 ? (
                      <span className="opacity-70"> · {group.count}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
