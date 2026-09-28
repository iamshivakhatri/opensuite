import { GitHubMark } from "@/components/marketing/github-mark";
import { SiteButton } from "@/components/marketing/site-button";
import { GITHUB_URL } from "@/lib/site";
import { isSignupAllowed } from "@/lib/signup";

/** Closing CTA band reused at the bottom of public content pages. */
export function MarketingClose() {
  const startHref = isSignupAllowed() ? "/sign-up" : "/sign-in";

  return (
    <section className="border-t border-line">
      <div className="os-container flex flex-col gap-8 py-20 sm:py-24 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="os-display text-[28px] leading-[1.15] sm:text-[34px]">
            Bring a document you actually use.
          </h2>
          <p className="os-body mt-4 max-w-[46ch]">
            Open a .docx, ask for one change, and read exactly what the agent
            did to it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SiteButton href={startHref}>Try OpenSuite</SiteButton>
          <SiteButton href={GITHUB_URL} variant="outline" external>
            <GitHubMark className="h-4 w-4" />
            GitHub
          </SiteButton>
        </div>
      </div>
    </section>
  );
}
