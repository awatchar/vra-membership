import type {
  SlipEvidence,
  SlipFailureReason,
  SlipTransaction,
  SlipVerificationProvider,
  SlipVerificationRequest,
  SlipVerificationResult,
} from '../types';

/**
 * SlipOK payment slip verification adapter.
 *
 * Contract (public documentation, August 2026):
 *   POST https://api.slipok.com/api/line/apikey/<branchId>
 *   header `x-authorization`, JSON body `{ data, amount, log }` for a QR
 *   payload, or multipart `files` for an image
 *
 * Two things matter beyond the mapping.
 *
 * **The slip image is never persisted.** In the preferred flow it never even
 * reaches the Worker: the browser decodes the QR and sends only the payload
 * (Issue #1 section 18). The image path exists as a fallback and is discarded
 * when the request ends.
 *
 * **`log: true` is always sent.** It is what makes SlipOK record the slip for
 * its own duplicate detection, so the second submission of the same slip is
 * refused by the provider as well as by our unique constraint. Two independent
 * checks on the one thing that would let someone join twice on one payment.
 */

const BASE_URL = 'https://api.slipok.com/api/line/apikey';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * SlipOK's own error codes, mapped to internal reasons.
 *
 * 1012 and 1013 are the two that matter most: a slip already seen, and an
 * amount that does not match what we told them to expect.
 */
const FAILURE_BY_CODE: Readonly<Record<number, SlipFailureReason>> = {
  1000: 'SLIP_UNREADABLE',
  1002: 'PROVIDER_ERROR', // bad API key: our problem, not the applicant's
  1004: 'PROVIDER_ERROR', // quota exhausted
  1006: 'SLIP_UNREADABLE',
  1007: 'SLIP_UNREADABLE',
  1008: 'SLIP_UNREADABLE',
  1011: 'SLIP_NOT_FOUND',
  1012: 'DUPLICATE_SLIP',
  1013: 'AMOUNT_MISMATCH',
};

interface SlipOkParty {
  displayName?: unknown;
  name?: unknown;
  account?: { value?: unknown } | undefined;
  proxy?: { value?: unknown } | undefined;
}

interface SlipOkData {
  success?: unknown;
  transRef?: unknown;
  transDate?: unknown;
  transTime?: unknown;
  transTimestamp?: unknown;
  amount?: unknown;
  sendingBank?: unknown;
  receivingBank?: unknown;
  receiver?: SlipOkParty | undefined;
}

interface SlipOkResponse {
  success?: unknown;
  code?: unknown;
  data?: SlipOkData | undefined;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Digits only, for comparing a masked account against a configured one. */
function digits(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const onlyDigits = raw.replace(/\D/g, '');
  return onlyDigits.length > 0 ? onlyDigits : null;
}

/**
 * Converts the transferred amount to satang.
 *
 * SlipOK sends a decimal. Rounding at the boundary keeps every later comparison
 * an integer one, so `500` and `499.999999` cannot end up looking different
 * from the expected total by a fraction of a satang.
 */
function amountSatang(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(text(value));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric * 100);
}

/**
 * Builds an ISO instant from whichever time fields are present.
 *
 * `transTimestamp` is documented as ISO 8601 but is optional, so `transDate`
 * (`yyyyMMdd`) and `transTime` (`HH:mm:ss`) are the fallback. Those two are
 * Bangkok local time, which is why the offset is written explicitly rather than
 * left for a parser to guess.
 */
export function slipTransactionInstant(data: {
  transTimestamp?: unknown;
  transDate?: unknown;
  transTime?: unknown;
}): string | null {
  const timestamp = text(data.transTimestamp);
  if (timestamp) {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const date = text(data.transDate);
  const time = text(data.transTime);
  if (date && /^\d{8}$/.test(date)) {
    const iso = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const clock = time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? time : '00:00:00';
    const parsed = new Date(`${iso}T${clock}+07:00`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  return null;
}

/**
 * Narrows a SlipOK response to the internal model.
 *
 * Exported so the mapping can be tested without an HTTP round trip. Sender
 * details are deliberately dropped: who paid is already known from the
 * application, and the payer's masked account number has no business being
 * stored.
 */
export function mapSlipOkResponse(payload: unknown): SlipTransaction | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const response = payload as SlipOkResponse;
  const data = response.data;
  if (!data || data.success === false) return null;

  const transactionRef = text(data.transRef);
  const amount = amountSatang(data.amount);
  if (transactionRef === null || amount === null) return null;

  return {
    transactionRef,
    amount,
    sendingBank: text(data.sendingBank),
    receivingBank: text(data.receivingBank),
    // Banks mask most of the account number; these are the visible digits.
    receiverAccountDigits: digits(data.receiver?.account?.value),
    receiverName: text(data.receiver?.displayName) ?? text(data.receiver?.name),
    transactionAt: slipTransactionInstant(data),
  };
}

export interface SlipOkOptions {
  apiKey: string;
  /** Branch id, which forms part of the endpoint path. */
  branchId: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createSlipOkProvider(options: SlipOkOptions): SlipVerificationProvider {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const endpoint = `${baseUrl}/${options.branchId}`;

  const buildBody = (
    evidence: SlipEvidence,
    expectedAmountSatang: number,
  ): { body: BodyInit; headers: Record<string, string> } => {
    // The expected amount is sent so SlipOK cross-checks it too, but the answer
    // is re-verified locally: a provider's opinion is not the last word on what
    // the association was actually paid.
    const amount = expectedAmountSatang / 100;

    if (evidence.kind === 'qr') {
      return {
        body: JSON.stringify({ data: evidence.payload, amount, log: true }),
        headers: { 'content-type': 'application/json' },
      };
    }

    const form = new FormData();
    form.append('files', new Blob([evidence.image.bytes], { type: evidence.image.contentType }));
    form.append('amount', String(amount));
    form.append('log', 'true');
    return { body: form, headers: {} };
  };

  return {
    name: 'slipok',

    async verify(request: SlipVerificationRequest): Promise<SlipVerificationResult> {
      const { body, headers } = buildBody(request.evidence, request.expectedAmount);
      const timeout = AbortSignal.timeout(timeoutMs);

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'x-authorization': options.apiKey, ...headers },
          body,
          signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
        });
      } catch (error) {
        const timedOut = error instanceof Error && error.name === 'TimeoutError';
        return { ok: false, reason: timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR' };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, reason: 'PROVIDER_ERROR' };
      }

      if (!response.ok) {
        const code = (payload as SlipOkResponse | null)?.code;
        // An unmapped code becomes a generic provider error rather than being
        // reported as something it is not.
        return {
          ok: false,
          reason:
            (typeof code === 'number' ? FAILURE_BY_CODE[code] : undefined) ?? 'PROVIDER_ERROR',
        };
      }

      const transaction = mapSlipOkResponse(payload);
      if (transaction === null) {
        return { ok: false, reason: 'SLIP_UNREADABLE' };
      }

      return { ok: true, transaction };
    },
  };
}
