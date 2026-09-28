import type { Metadata } from "next";

import { HowItWorksPage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "How it works — OpenSuite",
  description:
    "How an OpenSuite agent run inspects a real .docx, applies typed operations, verifies the result, and saves one immutable version.",
};

export default function Page() {
  return <HowItWorksPage />;
}
