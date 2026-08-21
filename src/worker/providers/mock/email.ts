import type { EmailProvider, EmailSendResult, OutboundEmail } from '../types';

/** In-memory email provider. Nothing leaves the Worker. */

export interface MockEmailProvider extends EmailProvider {
  /** Emails captured so far, in send order. */
  readonly sent: readonly OutboundEmail[];
  reset(): void;
}

export interface MockEmailOptions {
  failWith?: Extract<EmailSendResult, { ok: false }>['reason'];
  /** Signature verification outcome for webhook tests. */
  signatureValid?: boolean;
}

export function createMockEmailProvider(options: MockEmailOptions = {}): MockEmailProvider {
  const sent: OutboundEmail[] = [];

  return {
    name: 'mock-email',
    sent,
    reset() {
      sent.length = 0;
    },
    async send(email: OutboundEmail): Promise<EmailSendResult> {
      if (options.failWith) {
        return { ok: false, reason: options.failWith };
      }
      sent.push(email);
      // A random id, not a per-instance counter. `emails.provider_email_id` is
      // unique, and a counter restarting at 1 for every new provider instance -
      // one per request - collided across requests. A real provider's ids are
      // globally unique, so the stand-in has to be too or it fails in a way the
      // real thing cannot.
      return { ok: true, providerEmailId: `mock-email-${crypto.randomUUID()}` };
    },
    async verifyWebhookSignature(): Promise<boolean> {
      return options.signatureValid ?? true;
    },
  };
}
