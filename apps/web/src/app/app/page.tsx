"use client";

import * as React from "react";

import { fetchMe, type Me } from "@/lib/api";

type MeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; me: Me | null };

export default function AppHomePage() {
  const [state, setState] = React.useState<MeState>({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;

    fetchMe()
      .then((me) => {
        if (!cancelled) setState({ status: "ready", me });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-[560px] px-6 py-24 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-[12px] bg-sunken text-ink-faint">
        ✦
      </div>
      <h1 className="mb-2 text-[25px] font-semibold tracking-[-0.03em] text-ink">
        Welcome to OpenSuite
      </h1>
      {state.status === "loading" ? (
        <p className="text-[12px] leading-relaxed text-ink-soft">
          Checking your session…
        </p>
      ) : state.status === "error" ? (
        <p className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          Could not reach the OpenSuite API: {state.message}
        </p>
      ) : state.me ? (
        <div className="text-[12px] leading-relaxed text-ink-soft">
          <p className="mb-3">
            Signed in as{" "}
            <span className="font-semibold text-ink">{state.me.name}</span> (
            {state.me.email}).
          </p>
          <p>
            This confirms <code className="text-[11px]">GET /api/me</code>{" "}
            recognized your session. Documents, workspaces, and the OpenSuite
            agent are not built yet — this is the authenticated shell only.
          </p>
        </div>
      ) : (
        <p className="rounded-[var(--radius-sm)] bg-danger-soft px-3 py-2 text-[12px] text-danger">
          The API did not recognize a session for this request.
        </p>
      )}
    </div>
  );
}
