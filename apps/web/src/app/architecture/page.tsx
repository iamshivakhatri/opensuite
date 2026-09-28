import type { Metadata } from "next";

import { ArchitecturePage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "Architecture — OpenSuite",
  description:
    "How the OpenSuite web app, API, agent runtime, and separate Rust document engine stay bounded so only the engine mutates Office files.",
};

export default function Page() {
  return <ArchitecturePage />;
}
