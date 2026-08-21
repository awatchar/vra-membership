import { timingSafeEqual } from '../../lib/crypto';
import type { EmailFailureReason, EmailProvider, EmailSendResult, OutboundEmail } from '../types';

/**
 * Resend transactional email adapter.
 *
 * Contract (public documentation, August 2026):
 *   POST https://api.resend.com/emails
 *   header `Authorization: Bearer <key>`, optional `Idempotency-Key`
 *   JSON body `{ from, to, subject, html, text, attachments, tags }`
 *   200 -> `{ id }`
 *
 * Webhooks are signed by Svix: headers `svix-id`, `svix-timestamp`,
 * `svix-signature`.
 *
 * Two things about this adapter are worth knowing before changing it.
 *
 * **The idempotency key is the caller's, not ours.** Resend deduplicates a
 * repeated key for 24 hours and returns the original id. The email service
 * passes its `emails` row id, so retrying a send whose outcome we never learned
 * - a timeout, a dropped connection - returns the first message instead of
 * mailing the member twice. This only works because every template is a pure
 * function of stored data: a body that varied between attempts would be
 * rejected as `invalid_idempotent_request` rather than deduplicated.
 *
 * **Open tracking is a property of the sending domain, not of a message.** The
 * API has no per-message flag, so `trackOpens` selects a second, separately
 * configured sender rather than setting a field. Without that second sender
 * configured, `trackOpens` has no effect and the manager's open cannot advance
 * the application - which is why the manager also has an explicit button
 * (Issue #1 section 34), and why nothing in the flow depends on tracking alone.
 */

const BASE_URL = 'https://api.resend.com';
const REQUEST_TIMEOUT_MS = 15_000;

/** Svix's own tolerance, and the value its libraries use. */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/** Resend accepts tag names and values in this alphabet only. */
const TAG_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Resend error codes mapped to internal reasons.
 *
 * The distinction that matters is our fault versus theirs. A rejected address,
 * an unverified domain or a malformed sender will fail the same way on every
 * retry, so they are `REJECTED`; quota and rate limits and 5xx are transient,
 * so they stay `PROVIDER_ERROR` and remain worth retrying.
 */
const FAILURE_BY_NAME: Readonly<Record<string, EmailFailureReason>> = {
  validation_error: 'REJECTED',
  invalid_from_address: 'REJECTED',
  invalid_attachment: 'REJECTED',
  missing_required_field: 'REJECTED',
  invalid_parameter: 'REJECTED',
  security_error: 'REJECTED',
  invalid_idempotency_key: 'REJECTED',
  invalid_idempotent_request: 'REJECTED',
  missing_api_key: 'PROVIDER_ERROR',
  invalid_api_key: 'PROVIDER_ERROR',
  restricted_api_key: 'PROVIDER_ERROR',
  concurrent_idempotent_requests: 'PROVIDER_ERROR',
  monthly_quota_exceeded: 'PROVIDER_ERROR',
  daily_quota_exceeded: 'PROVIDER_ERROR',
  rate_limit_exceeded: 'PROVIDER_ERROR',
  application_error: 'PROVIDER_ERROR',
  internal_server_error: 'PROVIDER_ERROR',
};

function base64(bytes: Uint8Array): string {
  // Chunked so a large attachment cannot exceed the argument limit of `apply`.
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Converts a tag map to Resend's array form, dropping anything outside the
 * allowed alphabet. A tag is a convenience for correlating messages later; it is
 * not worth failing a member's email over.
 */
function toTags(tags: Record<string, string> | undefined): { name: string; value: string }[] {
  if (!tags) return [];
  return Object.entries(tags)
    .filter(([name, value]) => TAG_PATTERN.test(name) && TAG_PATTERN.test(value))
    .map(([name, value]) => ({ name, value }));
}

/** The `name` field of a Resend error body, when there is one. */
function errorName(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const name = (payload as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

export interface ResendOptions {
  apiKey: string;
  /** Sender for member email, e.g. `VRA <membership@vra.or.th>`. */
  from: string;
  /**
   * Sender for messages that ask for open tracking. Should be a domain with
   * open tracking enabled in Resend; defaults to `from`, in which case
   * `trackOpens` does nothing.
   */
  trackedFrom?: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Clock used for the webhook timestamp tolerance. Injected by tests. */
  now?: () => Date;
}

export function createResendProvider(options: ResendOptions): EmailProvider {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const trackedFrom = options.trackedFrom ?? options.from;
  const now = options.now ?? (() => new Date());

  return {
    name: 'resend',

    async send(email: OutboundEmail): Promise<EmailSendResult> {
      const body: Record<string, unknown> = {
        from: email.trackOpens ? trackedFrom : options.from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        text: email.text,
      };

      if (email.attachments?.length) {
        body['attachments'] = email.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: base64(attachment.content),
          content_type: attachment.contentType,
        }));
      }

      const tags = toTags(email.tags);
      if (tags.length > 0) body['tags'] = tags;

      const headers: Record<string, string> = {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      };
      if (email.idempotencyKey) headers['idempotency-key'] = email.idempotencyKey;

      let response: Response;
      try {
        response = await fetch(`${baseUrl}/emails`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        return { ok: false, reason: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR' };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const mapped = FAILURE_BY_NAME[errorName(payload) ?? ''];
        if (mapped) return { ok: false, reason: mapped };
        // An unmapped failure is classified by status rather than guessed at:
        // 4xx will fail again, 5xx may not.
        return { ok: false, reason: response.status >= 500 ? 'PROVIDER_ERROR' : 'REJECTED' };
      }

      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id !== 'string' || id.length === 0) {
        // Accepted but unidentifiable. Reporting success without an id would
        // leave a row that no webhook could ever be matched to.
        return { ok: false, reason: 'PROVIDER_ERROR' };
      }

      return { ok: true, providerEmailId: id };
    },

    /**
     * Verifies a Svix signature over `${svix-id}.${svix-timestamp}.${payload}`.
     *
     * The timestamp check is what makes a captured request useless later: a
     * valid signature stays valid forever, so without it an attacker who once
     * saw a delivery webhook could replay it indefinitely.
     *
     * `payload` must be the raw request body, byte for byte. Re-serialising the
     * parsed JSON changes the whitespace and every signature stops matching.
     */
    async verifyWebhookSignature(request: {
      payload: string;
      headers: Headers;
      secret: string;
    }): Promise<boolean> {
      const id = request.headers.get('svix-id');
      const timestamp = request.headers.get('svix-timestamp');
      const signatureHeader = request.headers.get('svix-signature');
      if (!id || !timestamp || !signatureHeader) return false;

      const sentAt = Number(timestamp);
      if (!Number.isFinite(sentAt)) return false;
      const age = Math.abs(now().getTime() / 1000 - sentAt);
      if (age > WEBHOOK_TOLERANCE_SECONDS) return false;

      // `whsec_` is a readability prefix, not part of the key material.
      const secret = request.secret.startsWith('whsec_')
        ? request.secret.slice('whsec_'.length)
        : request.secret;

      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey(
          'raw',
          fromBase64(secret),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
      } catch {
        return false;
      }

      const signed = new TextEncoder().encode(`${id}.${timestamp}.${request.payload}`);
      const expected = base64(new Uint8Array(await crypto.subtle.sign('HMAC', key, signed)));

      // The header carries a space-delimited list so a secret can be rotated
      // with both signatures present. Every versioned entry is checked, and the
      // comparison is constant time even though only one can match.
      let matched = false;
      for (const entry of signatureHeader.split(' ')) {
        const [version, value] = entry.split(',');
        if (version !== 'v1' || !value) continue;
        if (timingSafeEqual(value, expected)) matched = true;
      }
      return matched;
    },
  };
}
