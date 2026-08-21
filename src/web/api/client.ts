import type {
  CreatedApplication,
  OcrResponse,
  PaymentInstructions,
  PaymentVerified,
  PhotoSource,
  PublicConfig,
  StoredPhoto,
  UpdatePayload,
  WorkflowReport,
} from './types';

/**
 * The only place the browser talks to the API.
 *
 * Two things this module is responsible for.
 *
 * **Turning an error into something the applicant can act on.** The API returns
 * a stable code and a Thai message written for an applicant; that message is
 * what gets shown. Anything else - a network failure, a gateway error, an
 * unparseable body - becomes a generic Thai message here, so no provider or
 * framework text can reach the screen (Issue #1 section 63).
 *
 * **Carrying the capability token.** It is held in memory by the wizard and
 * passed in on each call. It is deliberately never written to `localStorage`:
 * the token is the only thing protecting the application, and storage survives
 * the tab, gets synced by some browsers, and is readable by any script that ever
 * runs on the origin.
 */

export const ACCESS_TOKEN_HEADER = 'x-vra-application-token';
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-response';

/** What the wizard shows when the failure was not one the API described. */
const GENERIC_MESSAGE = 'ไม่สามารถติดต่อระบบได้ กรุณาตรวจสอบการเชื่อมต่อแล้วลองอีกครั้ง';

export class ApiRequestError extends Error {
  /** Stable machine code, e.g. `RATE_LIMITED`. `NETWORK` when there was none. */
  readonly code: string;
  /** Sub-reason for OCR and payment failures, when the API gave one. */
  readonly reason: string | null;
  readonly status: number;
  /** Field paths from a validation failure, never the submitted values. */
  readonly fields: string[];

  constructor(options: {
    code: string;
    message: string;
    status: number;
    reason?: string | null;
    fields?: string[];
  }) {
    super(options.message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.reason = options.reason ?? null;
    this.status = options.status;
    this.fields = options.fields ?? [];
  }
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    reason?: unknown;
    fields?: unknown;
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

async function failure(response: Response): Promise<ApiRequestError> {
  let body: ErrorBody | null;
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    body = null;
  }

  const error = body?.error;
  const message = typeof error?.message === 'string' ? error.message : GENERIC_MESSAGE;

  return new ApiRequestError({
    code: typeof error?.code === 'string' ? error.code : 'HTTP_ERROR',
    message,
    status: response.status,
    reason: typeof error?.reason === 'string' ? error.reason : null,
    fields: toStringArray(
      Array.isArray(error?.fields)
        ? (error.fields as unknown[]).map((entry) =>
            typeof entry === 'object' && entry !== null && 'path' in entry
              ? (entry as { path?: unknown }).path
              : entry,
          )
        : [],
    ),
  });
}

export interface RequestOptions {
  applicationToken?: string | null;
  turnstileToken?: string | null;
  signal?: AbortSignal;
}

async function send<T>(
  path: string,
  init: RequestInit,
  options: RequestOptions = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (options.applicationToken) headers.set(ACCESS_TOKEN_HEADER, options.applicationToken);
  if (options.turnstileToken) headers.set(TURNSTILE_TOKEN_HEADER, options.turnstileToken);

  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    // A rejected fetch is a transport failure, not an API answer. Its message
    // is a browser string in the browser's own language, so it is replaced.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiRequestError({ code: 'NETWORK', message: GENERIC_MESSAGE, status: 0 });
  }

  if (!response.ok) throw await failure(response);

  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiRequestError({ code: 'BAD_RESPONSE', message: GENERIC_MESSAGE, status: response.status });
  }
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

export const api = {
  config(signal?: AbortSignal): Promise<PublicConfig> {
    return send<PublicConfig>('/api/config', { method: 'GET' }, signal ? { signal } : {});
  },

  /**
   * Reads the front of an ID card.
   *
   * The image is sent as the raw body and kept nowhere: no caller writes it to
   * storage, and the response is `no-store` (Issue #1 section 6).
   */
  readIdCard(image: Blob, turnstileToken: string | null): Promise<OcrResponse> {
    return send<OcrResponse>(
      '/api/ocr',
      { method: 'POST', body: image, headers: { 'content-type': image.type } },
      { turnstileToken },
    );
  },

  createApplication(
    payload: {
      citizenId: string;
      title: string | null;
      firstName: string | null;
      lastName: string | null;
      firstNameEn: string | null;
      lastNameEn: string | null;
      birthDate: string | null;
      cardExpiryDate: string | null;
    },
    turnstileToken: string | null,
  ): Promise<CreatedApplication> {
    return send<CreatedApplication>('/api/applications', json(payload), { turnstileToken });
  },

  update(
    applicationId: string,
    payload: UpdatePayload,
    applicationToken: string,
  ): Promise<{ application: CreatedApplication['application'] }> {
    return send('/api/applications/' + applicationId, { ...json(payload), method: 'PATCH' }, {
      applicationToken,
    });
  },

  storePhoto(
    applicationId: string,
    photo: Blob,
    source: PhotoSource,
    applicationToken: string,
    turnstileToken: string | null,
  ): Promise<StoredPhoto> {
    const form = new FormData();
    form.append('applicationId', applicationId);
    form.append('source', source);
    // The applicant ticked the confirmation checklist; the server records that
    // it was given rather than inferring consent from the upload itself.
    form.append('confirmed', 'true');
    form.append('photo', photo, 'member-photo.jpg');

    return send<StoredPhoto>('/api/member-photo', { method: 'POST', body: form }, {
      applicationToken,
      turnstileToken,
    });
  },

  paymentInstructions(
    applicationId: string,
    applicationToken: string,
  ): Promise<PaymentInstructions> {
    return send<PaymentInstructions>(
      `/api/payment/instructions/${applicationId}`,
      { method: 'GET' },
      { applicationToken },
    );
  },

  /**
   * Submits the slip.
   *
   * `qrPayload` is the preferred path: the browser decodes the QR and the image
   * never leaves the device (Issue #1 section 18). The image is a fallback for
   * a slip whose QR will not read.
   */
  verifyPayment(
    applicationId: string,
    evidence: { qrPayload: string } | { slip: Blob },
    applicationToken: string,
    turnstileToken: string | null,
  ): Promise<PaymentVerified> {
    const form = new FormData();
    form.append('applicationId', applicationId);
    if ('qrPayload' in evidence) form.append('qrPayload', evidence.qrPayload);
    else form.append('slip', evidence.slip, 'slip.jpg');

    return send<PaymentVerified>('/api/payment/verify', { method: 'POST', body: form }, {
      applicationToken,
      turnstileToken,
    });
  },

  confirmation(
    applicationId: string,
    applicationToken: string,
  ): Promise<{ confirmation: WorkflowReport }> {
    return send(
      `/api/applications/${applicationId}/confirmation`,
      { method: 'GET' },
      { applicationToken },
    );
  },

  finalize(
    applicationId: string,
    applicationToken: string,
  ): Promise<{ confirmation: WorkflowReport }> {
    return send(
      `/api/applications/${applicationId}/finalize`,
      { method: 'POST' },
      { applicationToken },
    );
  },
};

export type Api = typeof api;
