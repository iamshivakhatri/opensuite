import type { Metadata } from "next";

import { OpenSourcePage } from "@/components/marketing/section-pages";

export const metadata: Metadata = {
  title: "Open source — OpenSuite",
  description:
    "OpenSuite is MIT licensed. Read the application and document engine repositories, self-host, or contribute.",
};

export default function Page() {
  return <OpenSourcePage />;
}
