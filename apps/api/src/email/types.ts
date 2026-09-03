export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Backend-owned boundary between OpenSuite and whatever transactional email
 * provider we use. Better Auth (and future callers) only ever see this
 * interface, never the provider SDK directly.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
