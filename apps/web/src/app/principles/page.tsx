import type { Metadata } from "next";

import { PrinciplesPage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "Principles — OpenSuite",
  description:
    "Why OpenSuite edits real documents through typed operations, preserves what you didn't ask about, and writes one version per run.",
};

export default function Page() {
  return <PrinciplesPage />;
}
