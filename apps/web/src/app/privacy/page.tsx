import type { Metadata } from "next";

import {
  LegalPage,
  type LegalSection,
} from "@/components/marketing/legal-page";
import { SUPPORT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy — OpenSuite",
  description:
    "How OpenSuite collects, stores, and uses account, document, and agent data.",
};

const sections: LegalSection[] = [
  {
    id: "account-information",
    title: "Account information",
    body: (
      <p>
        When you create an account, we store the information needed to identify
        you and operate your account: your email address, your display name if
        you provide one, and a securely hashed password if you sign up with
        email and password. We do not store your plaintext password.
      </p>
    ),
  },
  {
    id: "google-sign-in",
    title: "Google sign-in",
    body: (
      <p>
        If you sign in with Google, OpenSuite requests only the basic identity
        information required to create and authenticate your account — your
        name, email address, and profile photo, as provided by Google&apos;s
        standard OpenID sign-in scopes. OpenSuite does not request or access
        your Google Drive, Gmail, Calendar, or any other Google product data.
        Google sign-in is used solely to authenticate you; it is not used to
        import or sync content from your Google account.
      </p>
    ),
  },
  {
    id: "sessions",
    title: "Sessions and authentication",
    body: (
      <p>
        We use session cookies to keep you signed in and to protect your
        account. This is handled by our authentication library and is limited
        to what is required for sign-in, session management, and basic account
        security (such as email verification and password reset).
      </p>
    ),
  },
  {
    id: "documents",
    title: "Documents and document versions",
    body: (
      <p>
        Documents you upload or create in OpenSuite — and the versions produced
        as you or the agent edit them — are stored so that you can open, edit,
        and revert them. Document files are stored in object storage, and
        document metadata (names, workspaces, versions, and history) is stored
        in our database.
      </p>
    ),
  },
  {
    id: "agent-runs",
    title: "Agent prompts, messages, and runs",
    body: (
      <p>
        When you use the AI agent, we store your prompts, the agent&apos;s
        responses, and a record of the actions it took on your documents (an
        &ldquo;agent run&rdquo;) so that the conversation and edit history
        remain available to you across sessions.
      </p>
    ),
  },
  {
    id: "model-providers",
    title: "AI model providers",
    body: (
      <p>
        To generate agent responses and document edits, relevant document
        content and your prompts are sent to the AI model provider configured
        for your deployment (for example, an OpenRouter, Anthropic, or OpenAI
        model). These providers process that content to return a response;
        OpenSuite does not control their retention practices independently of
        their own terms.
      </p>
    ),
  },
  {
    id: "data-location",
    title: "Where product data is stored",
    body: (
      <p>
        Account, workspace, document metadata, and agent conversation data are
        stored in a PostgreSQL database operated for OpenSuite. Uploaded
        document files are stored in S3-compatible object storage. Neither is
        stored only on your device, and OpenSuite does not currently offer an
        offline mode.
      </p>
    ),
  },
  {
    id: "logs",
    title: "Operational and security logs",
    body: (
      <p>
        Our servers keep routine operational logs (such as request method,
        path, status code, and timing) to operate, debug, and secure the
        service. These logs are used for reliability and abuse prevention, not
        for advertising.
      </p>
    ),
  },
  {
    id: "email",
    title: "Email delivery",
    body: (
      <p>
        Transactional emails — such as email verification and password-reset
        messages — are sent through a third-party email delivery provider
        (Resend). Your email address and the content of these messages are
        shared with that provider solely to deliver them.
      </p>
    ),
  },
  {
    id: "purposes",
    title: "Why we process this data",
    body: (
      <p>
        We process this information to provide the core product: creating and
        authenticating your account, storing and rendering your documents,
        running the AI agent against your documents, keeping your workspace
        secure, and communicating essential account notices.
      </p>
    ),
  },
  {
    id: "service-providers",
    title: "Sharing with service providers",
    body: (
      <p>
        We share data only with the service providers needed to operate
        OpenSuite — for example, our database and object storage
        infrastructure, the configured AI model provider, and our email
        delivery provider — each solely to perform the function described
        above. We do not sell your personal information.
      </p>
    ),
  },
  {
    id: "retention",
    title: "Retention and deletion",
    body: (
      <p>
        Deleting a document or workspace moves it to Trash, where it is
        retained so it can be restored, rather than being deleted immediately.
        OpenSuite does not yet provide a self-service option to permanently
        delete your account or all associated data. To request deletion of your
        account or personal data, contact us at{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and we will
        process the request manually.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        As OpenSuite is an early-stage, actively developed product, this policy
        may be updated as functionality changes. We will update the date at the
        top of this page when it does.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about this policy or your data can be sent to{" "}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated="September 24, 2026"
      intro={
        <p>
          OpenSuite (&ldquo;OpenSuite&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;) is an open-source, AI-native Office application
          that lets you create, open, and edit real Office documents, and ask
          an AI agent to inspect and modify them. This policy explains what
          data OpenSuite collects, why, and how it is handled. OpenSuite is
          currently an early-stage alpha product.
        </p>
      }
      sections={sections}
    />
  );
}
