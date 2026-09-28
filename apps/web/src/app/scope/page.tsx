import type { Metadata } from "next";

import { ScopePage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "Scope today — OpenSuite",
  description:
    "What OpenSuite supports today in alpha — DOCX editing, agent runs, BYOK — and what is not ready yet.",
};

export default function Page() {
  return <ScopePage />;
}
