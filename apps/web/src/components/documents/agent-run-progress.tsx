"use client";

import * as React from "react";

import {
  detailsAffordanceLabel,
  formatProgressElapsed,
  type AgentActivity,
  type AgentProgressLine,
  type AgentRunPresentation,
} from "@/lib/agent-progress";
import { focusRingClass } from "@/lib/focus-scope";
import { cn } from "@/lib/utils";

/** Local 1s timer — does not re-render the whole transcript. */
function ThinkingElapsed({ startedAt }: { startedAt?: number }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (startedAt === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  if (startedAt === undefined) return null;
  const ms = Math.max(0, now - startedAt);
  if (ms < 100) return null;
  return (
    <span className="shrink-0 tabular-nums text-ink-faint">
      · {formatProgressElapsed(ms)}
    </span>
  );
}

function ActivityGlyph({
  activity,
}: {
  activity: AgentActivity;
}) {
  if (activity.status === "error") {
    return (
      <span className="w-3 shrink-0 text-center text-danger" aria-hidden>
        !
      </span>
    );
  }
  if (activity.status === "active") {
    if (activity.kind === "thinking") {
      return (
        <span className="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden>
          <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-ink-faint opacity-40" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full border border-ink-faint/80" />
        </span>
      );
    }
    if (activity.kind === "read") {
      return (
        <span className="w-3 shrink-0 text-center text-ink-faint" aria-hidden>
          ⌕
        </span>
      );
    }
    if (activity.kind === "mutate" || activity.kind === "lifecycle") {
      return (
        <span className="w-3 shrink-0 text-center text-ink-soft" aria-hidden>
          ✎
        </span>
      );
    }
    return (
      <span className="relative flex h-3 w-3 shrink-0 items-center justify-center" aria-hidden>
        <span className="absolute inline-flex h-1.5 w-1.5 animate-ping rounded-full bg-accent opacity-35" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
      </span>
    );
  }
  // done
  return (
    <span
      className={cn(
        "w-3 shrink-0 text-center text-[length:var(--text-2xs)]",
        activity.weight === "emphasis" ? "text-ink-soft" : "text-ink-faint",
      )}
      aria-hidden
    >
      ✓
    </span>
  );
}

/** Single progressive activity row (presentation only). */
export function ActivityRow({ activity }: { activity: AgentActivity }) {
  const isActive = activity.status === "active";
  return (
    <li
      className={cn(
        "flex min-w-0 items-baseline gap-1.5 text-[length:var(--text-2xs)] leading-[1.45]",
        activity.status === "error"
          ? "text-danger"
          : isActive
            ? activity.weight === "emphasis"
              ? "text-ink"
              : "text-ink-soft"
            : activity.weight === "emphasis"
              ? "text-ink-soft"
              : "text-ink-faint",
      )}
    >
      <ActivityGlyph activity={activity} />
      <span className="min-w-0 flex-1 truncate">
        <span
          className={cn(
            isActive && activity.weight === "emphasis" ? "font-medium" : undefined,
          )}
        >
          {activity.label}
        </span>
        {activity.liveElapsed ? (
          <ThinkingElapsed startedAt={activity.startedAt} />
        ) : null}
        {activity.detail ? (
          <span className="mt-0.5 block truncate pl-0 text-[length:var(--text-2xs)] opacity-70">
            {activity.detail}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** One coherent activity block per run — subordinate to conversation. */
export function AgentActivityGroup({
  activities,
  live = false,
}: {
  activities: readonly AgentActivity[];
  live?: boolean;
}) {
  if (activities.length === 0) return null;
  return (
    <ul
      className="mt-1.5 space-y-0.5"
      aria-label={live ? "Agent activity" : "Run activity"}
    >
      {activities.map((activity) => (
        <ActivityRow key={activity.id} activity={activity} />
      ))}
    </ul>
  );
}

/** Professional run progress: progressive activity live; compact when done. */
export function AgentRunProgress({
  presentation,
  status,
  totalElapsed,
  expanded,
  onToggle,
  live = false,
  showDetails = true,
}: {
  presentation: AgentRunPresentation;
  status: AgentProgressLine["status"];
  totalElapsed?: string | null;
  expanded: boolean;
  onToggle: () => void;
  live?: boolean;
  showDetails?: boolean;
}) {
  const isActive = status === "active" || live;
  const hasDetails = showDetails && presentation.actionCount > 0;
  const detailsLabel = expanded
    ? "Hide details"
    : detailsAffordanceLabel(presentation.actionCount);

  return (
    <div className="min-w-0">
      {/* Live with rows: activity group is the primary surface (no duplicate headline).
          Completed / streaming-finish: compact headline. */}
      {presentation.activities.length === 0 ? (
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
      ) : null}

      {/* Tool facts remain visible after completion; only the elapsed timer is live. */}
      {presentation.activities.length > 0 ? (
        <AgentActivityGroup activities={presentation.activities} live={isActive} />
      ) : null}

      {hasDetails ? (
        <div className={cn(isActive && presentation.activities.length > 0 ? "mt-1" : "mt-1")}>
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
