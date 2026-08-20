/**
 * HTTP helpers shared by every route.
 *
 * Error responses expose a stable machine-readable code and a Thai message that
 * is safe to show to an applicant. Raw provider errors and internal details are
 * never forwarded to the client (see Issue #1 section 65).
 */

export type ApiErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'OCR_FAILED'
  | 'PAYMENT_REJECTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  OCR_FAILED: 422,
  PAYMENT_REJECTED: 422,
  PROVIDER_UNAVAILABLE: 503,
  NOT_IMPLEMENTED: 501,
  INTERNAL_ERROR: 500,
};

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    /** Thai, applicant-safe. Never contains provider or stack details. */
    message: string;
    requestId?: string;
  };
}

export function statusForErrorCode(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

/** Thrown by routes and services; the top-level handler maps it to a response. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly publicMessage: string;

  constructor(code: ApiErrorCode, publicMessage: string, options?: { cause?: unknown }) {
    super(`${code}: ${publicMessage}`, options);
    this.name = 'ApiError';
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function errorBody(code: ApiErrorCode, message: string, requestId?: string): ApiErrorBody {
  return { error: requestId ? { code, message, requestId } : { code, message } };
}
