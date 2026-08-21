/**
 * Provider boundaries for the three external services.
 *
 * Business logic depends only on these interfaces and on the internal models
 * below. Vendor response shapes are mapped at the adapter edge so that no raw
 * provider payload ever reaches a service, the database, a log or an email
 * (Issue #1 sections 75-76).
 */

/** Bytes plus declared content type; used for images that must not be persisted. */
export interface ImagePayload {
  bytes: Uint8Array;
  contentType: string;
}

/* ---------------------------------------------------------------- OCR ----- */

/**
 * The subset of Thai national ID card fields the membership process needs.
 * Deliberately omits religion, gender, issue date, bounding boxes and any other
 * field without a business purpose (Issue #1 section 8).
 */
export interface ThaiIdCardData {
  citizenId: string;
  titleTh: string | null;
  firstNameTh: string | null;
  lastNameTh: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  /** ISO `YYYY-MM-DD` in the Gregorian calendar. */
  birthDate: string | null;
  /** ISO `YYYY-MM-DD` in the Gregorian calendar. */
  cardExpiryDate: string | null;
  addressLine: string | null;
  subdistrict: string | null;
  district: string | null;
  province: string | null;
  /** Cropped face image only. The full card image is never returned or stored. */
  faceImage: ImagePayload | null;
}

export type OcrFailureReason =
  | 'UNREADABLE'
  | 'NOT_A_THAI_ID_CARD'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_REJECTED_IMAGE';

export type OcrResult =
  { ok: true; data: ThaiIdCardData } | { ok: false; reason: OcrFailureReason };

export interface OcrProvider {
  readonly name: string;
  /**
   * Reads the front of a Thai national ID card. Implementations must keep the
   * image in request memory only and must not persist or log it.
   */
  readThaiIdCardFront(image: ImagePayload, signal?: AbortSignal): Promise<OcrResult>;
}

/* --------------------------------------------------- Slip verification ----- */

/** Either a decoded QR payload (preferred) or the slip image (fallback). */
export type SlipEvidence = { kind: 'qr'; payload: string } | { kind: 'image'; image: ImagePayload };

export interface SlipVerificationRequest {
  evidence: SlipEvidence;
  /** Resolved server-side from the membership type. Never taken from the client. */
  expectedAmount: number;
  signal?: AbortSignal;
}

/** Internal payment model. Contains no vendor-specific fields. */
export interface SlipTransaction {
  transactionRef: string;
  amount: number;
  sendingBank: string | null;
  receivingBank: string | null;
  /**
   * Digits the provider left visible for the receiver account. Banks mask
   * most of the number, so this is a partial value and matching has to account
   * for that.
   */
  receiverAccountDigits: string | null;
  receiverName: string | null;
  /** ISO 8601 instant of the transfer as reported by the provider. */
  transactionAt: string | null;
}

export type SlipFailureReason =
  | 'SLIP_NOT_FOUND'
  | 'SLIP_UNREADABLE'
  | 'DUPLICATE_SLIP'
  | 'AMOUNT_MISMATCH'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_TIMEOUT';

export type SlipVerificationResult =
  { ok: true; transaction: SlipTransaction } | { ok: false; reason: SlipFailureReason };

export interface SlipVerificationProvider {
  readonly name: string;
  verify(request: SlipVerificationRequest): Promise<SlipVerificationResult>;
}

/* -------------------------------------------------------------- Email ----- */

export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutboundEmail {
  to: string;
  subject: string;
  html: string;
  /** Required: every template ships a plain-text fallback (Issue #1 section 55). */
  text: string;
  attachments?: EmailAttachment[];
  /** Opt into provider open tracking; used for the manager notification only. */
  trackOpens?: boolean;
  /** Correlation tag stored by the provider, e.g. the internal application id. */
  tags?: Record<string, string>;
  /**
   * Deduplication key honoured by the provider. Sending the same key twice
   * returns the first message rather than mailing the recipient again, which is
   * what makes a retry after an unknown outcome safe.
   */
  idempotencyKey?: string;
}

export type EmailFailureReason = 'REJECTED' | 'PROVIDER_ERROR' | 'PROVIDER_TIMEOUT';

export type EmailSendResult =
  { ok: true; providerEmailId: string } | { ok: false; reason: EmailFailureReason };

export interface EmailProvider {
  readonly name: string;
  send(email: OutboundEmail): Promise<EmailSendResult>;
  /**
   * Verifies a provider webhook signature. Implementations must be constant
   * time and must reject stale timestamps.
   */
  verifyWebhookSignature(request: {
    payload: string;
    headers: Headers;
    secret: string;
  }): Promise<boolean>;
}

/* ----------------------------------------------------------- Container ---- */

export interface Providers {
  ocr: OcrProvider;
  slip: SlipVerificationProvider;
  email: EmailProvider;
}
