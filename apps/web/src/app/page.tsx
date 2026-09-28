import type { Metadata } from "next";

import { HomePage } from "@/components/marketing/home-page";
import { RedirectSignedIn } from "@/components/marketing/redirect-signed-in";

export const metadata: Metadata = {
  title: "OpenSuite — an agent that edits the document, not a copy of it",
  description:
    "OpenSuite is an open-source AI workspace for editing real Word documents. It inspects your .docx and applies targeted changes through a deterministic document engine.",
};

export default function RootPage() {
  return (
    <>
      {/* `/` renders immediately; signed-in visitors are moved to /app. */}
      <RedirectSignedIn />
      <HomePage />
    </>
  );
}
