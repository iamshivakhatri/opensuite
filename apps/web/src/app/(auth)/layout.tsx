import type { ReactNode } from "react";

import { Wordmark } from "@/components/wordmark";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-paper px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex justify-center">
          <Wordmark />
        </div>
        <div className="rounded-[var(--radius-lg)] border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(16,24,40,0.03),0_12px_32px_rgba(16,24,40,0.07)]">
          {children}
        </div>
      </div>
    </div>
  );
}
