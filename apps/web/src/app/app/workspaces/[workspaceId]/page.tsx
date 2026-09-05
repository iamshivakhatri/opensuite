"use client";

import * as React from "react";

import { WorkspaceHome } from "@/components/documents/workspace-home";

export default function WorkspacePage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = React.use(params);
  return <WorkspaceHome workspaceId={workspaceId} />;
}
