"use client";

import * as React from "react";

import { WorkspaceRouteShell } from "@/components/documents/workspace-route-shell";

/**
 * Persistent layout for workspace + nested document routes.
 * Keeps the IDE mounted across tab/file switches.
 */
export function WorkspaceLayoutClient({
  children: _children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = React.use(params);
  // Nested pages are intentionally empty — the shell reads the URL and
  // keeps the IDE mounted across document switches.
  return <WorkspaceRouteShell workspaceId={workspaceId} />;
}
