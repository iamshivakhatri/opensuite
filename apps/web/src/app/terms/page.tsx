import type { Metadata } from "next";

import { LegalPage } from "@/components/marketing/legal-page";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of Service — OpenSuite",
  description: "The terms that govern use of the OpenSuite alpha.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="September 24, 2026">
      <p>
        These Terms of Service ("Terms") govern your use of OpenSuite, an
        open-source, AI-native Office application. By creating an account or
        using OpenSuite, you agree to these Terms.
      </p>

      <section>
        <h2>Alpha status</h2>
        <p>
          OpenSuite is an early-stage, actively developed alpha product.
          Features, behavior, and availability may change, and the service
          may contain bugs. Do not rely on OpenSuite as the sole copy or
          backup of any document that matters to you.
        </p>
      </section>

      <section>
        <h2>Eligibility and accounts</h2>
        <p>
          You must provide accurate account information and keep your
          credentials secure. You are responsible for activity that occurs
          under your account.
        </p>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <ul>
          <li>Do not use OpenSuite for unlawful, harmful, or abusive purposes.</li>
          <li>
            Do not attempt to disrupt, overload, or gain unauthorized access
            to OpenSuite's systems or other users' accounts or documents.
          </li>
          <li>
            Do not upload content you do not have the right to upload, or
            content that infringes another party's rights.
          </li>
        </ul>
      </section>

      <section>
        <h2>Your content</h2>
        <p>
          You retain ownership of the documents and content you upload or
          create in OpenSuite. You are solely responsible for that content
          and for the instructions you give the AI agent. We do not claim
          ownership over your documents.
        </p>
      </section>

      <section>
        <h2>The AI agent</h2>
        <p>
          The agent edits documents based on your instructions using a
          configured AI model provider. AI-generated edits and responses may
          be incomplete or incorrect. Review changes made to your documents
          before relying on them.
        </p>
      </section>

      <section>
        <h2>Third-party services</h2>
        <p>
          OpenSuite relies on third-party infrastructure and AI model
          providers to operate (for example, database and storage
          infrastructure, an AI model provider, and an email delivery
          provider). Your use of OpenSuite is also subject to the
          availability and terms of those providers.
        </p>
      </section>

      <section>
        <h2>Open-source software</h2>
        <p>
          OpenSuite's application and document engine source code are
          published under an open-source license in its public repository.
          These Terms govern your use of the hosted OpenSuite service; use
          of the source code itself is governed by the applicable
          open-source license in that repository.
        </p>
      </section>

      <section>
        <h2>Availability and changes</h2>
        <p>
          We may modify, suspend, or discontinue any part of OpenSuite,
          including the hosted service, at any time, with or without
          notice, particularly given its alpha status.
        </p>
      </section>

      <section>
        <h2>Disclaimer and limitation of liability</h2>
        <p>
          OpenSuite is provided "as is" and "as available," without
          warranties of any kind, express or implied. To the maximum extent
          permitted by law, OpenSuite and its operators are not liable for
          any indirect, incidental, or consequential damages, or for loss of
          data or content, arising from your use of the service.
        </p>
      </section>

      <section>
        <h2>Termination</h2>
        <p>
          You may stop using OpenSuite at any time. We may suspend or
          terminate access to accounts that violate these Terms or that pose
          a risk to the service or other users.
        </p>
      </section>

      <section>
        <h2>Changes to these Terms</h2>
        <p>
          We may update these Terms as OpenSuite evolves. Continued use of
          OpenSuite after a change takes effect constitutes acceptance of
          the updated Terms.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about these Terms can be sent to{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary">
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
      </section>
    </LegalPage>
  );
}
