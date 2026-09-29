import type { Metadata } from "next";

import { HowItWorksPage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "How it works — OpenSuite",
  description:
    "How an OpenSuite agent run inspects your real .docx, applies the change you asked for, verifies the result, and saves one immutable version.",
};

export default function Page() {
  return <HowItWorksPage />;
}
