import type { Metadata } from "next";

import {
  LegalPage,
  type LegalSection,
} from "@/components/marketing/legal-page";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service — OpenSuite",
  description: "The terms that govern use of the OpenSuite alpha.",
};

const sections: LegalSection[] = [
  {
    id: "alpha-status",
    title: "Alpha status",
    body: (
      <p>
        OpenSuite is an early-stage, actively developed alpha product. Features,
        behavior, and availability may change, and the service may contain
        bugs. Do not rely on OpenSuite as the sole copy or backup of any
        document that matters to you.
      </p>
    ),
  },
  {
    id: "accounts",
    title: "Eligibility and accounts",
    body: (
      <p>
        You must provide accurate account information and keep your credentials
        secure. You are responsible for activity that occurs under your account.
      </p>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <ul>
        <li>
          Do not use OpenSuite for unlawful, harmful, or abusive purposes.
        </li>
        <li>
          Do not attempt to disrupt, overload, or gain unauthorized access to
          OpenSuite&apos;s systems or other users&apos; accounts or documents.
        </li>
        <li>
          Do not upload content you do not have the right to upload, or content
          that infringes another party&apos;s rights.
        </li>
      </ul>
    ),
  },
  {
    id: "your-content",
    title: "Your content",
    body: (
      <p>
        You retain ownership of the documents and content you upload or create
        in OpenSuite. You are solely responsible for that content and for the
        instructions you give the AI agent. We do not claim ownership over your
        documents.
      </p>
    ),
  },
  {
    id: "the-agent",
    title: "The AI agent",
    body: (
      <p>
        The agent edits documents based on your instructions using a configured
        AI model provider. AI-generated edits and responses may be incomplete
        or incorrect. Review changes made to your documents before relying on
        them.
      </p>
    ),
  },
  {
    id: "third-party",
    title: "Third-party services",
    body: (
      <p>
        OpenSuite relies on third-party infrastructure and AI model providers to
        operate (for example, database and storage infrastructure, an AI model
        provider, and an email delivery provider). Your use of OpenSuite is also
        subject to the availability and terms of those providers.
      </p>
    ),
  },
  {
    id: "open-source",
    title: "Open-source software",
    body: (
      <p>
        OpenSuite&apos;s application and document engine source code are
        published under an open-source license in its public repository. These
        Terms govern your use of the hosted OpenSuite service; use of the source
        code itself is governed by the applicable open-source license in that
        repository.
      </p>
    ),
  },
  {
    id: "availability",
    title: "Availability and changes",
    body: (
      <p>
        We may modify, suspend, or discontinue any part of OpenSuite, including
        the hosted service, at any time, with or without notice, particularly
        given its alpha status.
      </p>
    ),
  },
  {
    id: "disclaimer",
    title: "Disclaimer and limitation of liability",
    body: (
      <p>
        OpenSuite is provided &ldquo;as is&rdquo; and &ldquo;as
        available,&rdquo; without warranties of any kind, express or implied. To
        the maximum extent permitted by law, OpenSuite and its operators are not
        liable for any indirect, incidental, or consequential damages, or for
        loss of data or content, arising from your use of the service.
      </p>
    ),
  },
  {
    id: "termination",
    title: "Termination",
    body: (
      <p>
        You may stop using OpenSuite at any time. We may suspend or terminate
        access to accounts that violate these Terms or that pose a risk to the
        service or other users.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms",
    body: (
      <p>
        We may update these Terms as OpenSuite evolves. Continued use of
        OpenSuite after a change takes effect constitutes acceptance of the
        updated Terms.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these Terms can be sent to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="September 24, 2026"
      intro={
        <p>
          These Terms of Service (&ldquo;Terms&rdquo;) govern your use of
          OpenSuite, an open-source, AI-native Office application. By creating
          an account or using OpenSuite, you agree to these Terms.
        </p>
      }
      sections={sections}
    />
  );
}
