"use client";

import { Suspense } from "react";

import { SearchPageView } from "@/components/search/search-page-view";

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="px-8 py-8 text-[12px] text-ink-faint">Loading search…</div>
      }
    >
      <SearchPageView />
    </Suspense>
  );
}
