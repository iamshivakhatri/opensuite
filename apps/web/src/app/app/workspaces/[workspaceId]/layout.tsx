import type { Metadata } from "next";

import { WorkspaceLayoutClient } from "./workspace-layout-client";

export const metadata: Metadata = {
  title: "OpenSuite",
};

/**
 * Server layout so the browser tab keeps a stable OpenSuite title across
 * document soft-navigations. IDE chrome lives in the client shell.
 */
export default function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  return (
    <WorkspaceLayoutClient params={params}>{children}</WorkspaceLayoutClient>
  );
}
