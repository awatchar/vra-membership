/**
 * Internal data models.
 *
 * Rows never leave the `db` module: every repository method maps a D1 row to
 * one of the types below, so callers cannot accidentally depend on column
 * names, on SQLite's integer booleans, or on a column that was added for a
 * different purpose.
 *
 * Money is stored and passed around in satang (1 THB = 100 satang) so that no
 * arithmetic anywhere in the payment path uses a floating-point baht value.
 */

export const APPLICATION_STATUSES = [
  'DRAFT',
  'AWAITING_PAYMENT',
  'PAYMENT_VERIFIED',
  'SUBMITTED',
  'MANAGER_NOTIFIED',
  'NBTC_PROCESSING',
  'NBTC_RECORDED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
  'REFUND_REQUIRED',
  'REFUNDED',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export const MEMBERSHIP_TYPES = ['FIVE_YEAR', 'LIFETIME'] as const;
export type MembershipType = (typeof MEMBERSHIP_TYPES)[number];

export const PHOTO_SOURCES = ['ID_CARD', 'UPLOAD'] as const;
export type PhotoSource = (typeof PHOTO_SOURCES)[number];

export const EMAIL_TYPES = [
  'RECEIPT',
  'MANAGER_NEW_APPLICATION',
  'MEMBER_PROCESSING',
  'MEMBER_NBTC_COMPLETED',
] as const;
export type EmailType = (typeof EMAIL_TYPES)[number];

export const EMAIL_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED'] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

export const ACTOR_TYPES = ['APPLICANT', 'MANAGER', 'SYSTEM', 'PROVIDER'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface ApplicationRecord {
  id: string;
  referenceNo: string | null;
  citizenIdHash: string;
  citizenIdCiphertext: string;
  title: string | null;
  firstName: string | null;
  lastName: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  birthDate: string | null;
  cardExpiryDate: string | null;
  phone: string | null;
  email: string | null;
  callsign: string | null;
  membershipType: MembershipType | null;
  membershipAmountSatang: number | null;
  photoKey: string | null;
  photoSource: PhotoSource | null;
  photoUploadedAt: string | null;
  status: ApplicationStatus;
  submittedAt: string | null;
  managerAcknowledgedAt: string | null;
  nbtcRecordedAt: string | null;
  nbtcRecordedBy: string | null;
  /** Keyed hash of the applicant's capability token; null means unreadable. */
  accessTokenHash: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Identity fields the applicant has reviewed and confirmed. */
export interface ApplicationIdentityInput {
  citizenIdHash: string;
  citizenIdCiphertext: string;
  /** Set at creation only; there is no path to change it afterwards. */
  accessTokenHash?: string;
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  firstNameEn?: string | null;
  lastNameEn?: string | null;
  birthDate?: string | null;
  cardExpiryDate?: string | null;
}

export interface ApplicationContactInput {
  phone?: string | null;
  email?: string | null;
  callsign?: string | null;
}

export interface AddressRecord {
  id: string;
  applicationId: string;
  idAddress: string | null;
  idSubdistrict: string | null;
  idDistrict: string | null;
  idProvince: string | null;
  mailSameAsId: boolean;
  mailRecipient: string | null;
  mailAddress: string | null;
  mailSubdistrict: string | null;
  mailDistrict: string | null;
  mailProvince: string | null;
  mailPostcode: string | null;
  mailPhone: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AddressInput = Omit<AddressRecord, 'id' | 'applicationId' | 'createdAt' | 'updatedAt'>;

export interface PaymentRecord {
  id: string;
  applicationId: string;
  provider: string;
  transactionRef: string;
  amountSatang: number;
  sendingBank: string | null;
  receivingBank: string | null;
  receiverAccountDigits: string | null;
  transactionAt: string | null;
  receiverMatched: boolean;
  amountMatched: boolean;
  verificationStatus: 'VERIFIED' | 'REJECTED';
  verifiedAt: string | null;
  createdAt: string;
}

export type PaymentInput = Omit<PaymentRecord, 'id' | 'createdAt'>;

export interface ReceiptRecord {
  id: string;
  applicationId: string;
  paymentId: string;
  receiptNo: string;
  amountSatang: number;
  issuedAt: string;
  emailSentAt: string | null;
}

export type ReceiptInput = Omit<ReceiptRecord, 'id' | 'emailSentAt'>;

export interface EmailRecord {
  id: string;
  applicationId: string;
  type: EmailType;
  recipient: string;
  provider: string;
  providerEmailId: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  firstOpenedAt: string | null;
  firstClickedAt: string | null;
  status: EmailStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EmailInput {
  applicationId: string;
  type: EmailType;
  recipient: string;
  provider: string;
}

/**
 * Audit metadata. Values are primitives only, mirroring the logger's rule:
 * an object here could smuggle a provider payload into the audit trail.
 */
export type EventMetadata = Record<string, string | number | boolean>;

export interface ApplicationEventRecord {
  id: string;
  applicationId: string;
  eventType: string;
  metadata: EventMetadata | null;
  actorType: ActorType;
  actorId: string | null;
  createdAt: string;
}

export interface ApplicationEventInput {
  applicationId: string;
  eventType: string;
  actorType: ActorType;
  actorId?: string | null;
  metadata?: EventMetadata;
}

export interface ApplicationListQuery {
  statuses?: readonly ApplicationStatus[];
  limit?: number;
  offset?: number;
}
