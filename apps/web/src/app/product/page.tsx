import type { Metadata } from "next";

import { ProductPage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "Product — OpenSuite",
  description:
    "The OpenSuite workspace: file explorer, the open DOCX, and the agent panel that runs targeted document changes.",
};

export default function Page() {
  return <ProductPage />;
}
