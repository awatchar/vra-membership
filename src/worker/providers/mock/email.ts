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
  let counter = 0;

  return {
    name: 'mock-email',
    sent,
    reset() {
      sent.length = 0;
      counter = 0;
    },
    async send(email: OutboundEmail): Promise<EmailSendResult> {
      if (options.failWith) {
        return { ok: false, reason: options.failWith };
      }
      sent.push(email);
      counter += 1;
      return { ok: true, providerEmailId: `mock-email-${counter}` };
    },
    async verifyWebhookSignature(): Promise<boolean> {
      return options.signatureValid ?? true;
    },
  };
}
