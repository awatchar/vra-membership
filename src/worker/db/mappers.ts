import type {
  ActorType,
  AddressRecord,
  ApplicationEventRecord,
  ApplicationRecord,
  ApplicationStatus,
  EmailRecord,
  EmailStatus,
  EmailType,
  EventMetadata,
  MembershipType,
  PaymentReviewRecord,
  PaymentReviewStatus,
  PaymentRecord,
  PhotoSource,
  ReceiptRecord,
} from './types';

/**
 * Row-to-model mapping. These functions are the only place that knows column
 * names, and the only place that converts SQLite's 0/1 into booleans.
 */

type Row = Record<string, unknown>;

function text(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === 'string' ? value : null;
}

function requiredText(row: Row, column: string): string {
  const value = text(row, column);
  if (value === null) {
    throw new Error(`Row is missing required column: ${column}`);
  }
  return value;
}

function integer(row: Row, column: string): number | null {
  const value = row[column];
  return typeof value === 'number' ? value : null;
}

function requiredInteger(row: Row, column: string): number {
  const value = integer(row, column);
  if (value === null) {
    throw new Error(`Row is missing required column: ${column}`);
  }
  return value;
}

function boolean(row: Row, column: string): boolean {
  return integer(row, column) === 1;
}

/**
 * Audit metadata is written by this module, so a value that does not parse or
 * is not a flat object of primitives means the row was written by something
 * else. Dropping it is safer than passing an unknown shape through.
 */
function metadata(row: Row, column: string): EventMetadata | null {
  const raw = text(row, column);
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const result: EventMetadata = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

export function toApplicationRecord(row: Row): ApplicationRecord {
  const canonicalMembership = text(row, 'membership_term');
  const legacyMembership = text(row, 'membership_type');

  return {
    id: requiredText(row, 'id'),
    referenceNo: text(row, 'reference_no'),
    citizenIdHash: requiredText(row, 'citizen_id_hash'),
    citizenIdCiphertext: requiredText(row, 'citizen_id_ciphertext'),
    title: text(row, 'title'),
    firstName: text(row, 'first_name'),
    lastName: text(row, 'last_name'),
    firstNameEn: text(row, 'first_name_en'),
    lastNameEn: text(row, 'last_name_en'),
    birthDate: text(row, 'birth_date'),
    cardExpiryDate: text(row, 'card_expiry_date'),
    phone: text(row, 'phone'),
    email: text(row, 'email'),
    callsign: text(row, 'callsign'),
    membershipType: (canonicalMembership ??
      (legacyMembership === 'ANNUAL' ? 'FIVE_YEAR' : legacyMembership)) as MembershipType | null,
    membershipAmountSatang: integer(row, 'membership_amount'),
    photoKey: text(row, 'photo_key'),
    photoSource: text(row, 'photo_source') as PhotoSource | null,
    photoUploadedAt: text(row, 'photo_uploaded_at'),
    status: requiredText(row, 'status') as ApplicationStatus,
    submittedAt: text(row, 'submitted_at'),
    managerAcknowledgedAt: text(row, 'manager_acknowledged_at'),
    nbtcRecordedAt: text(row, 'nbtc_recorded_at'),
    nbtcRecordedBy: text(row, 'nbtc_recorded_by'),
    accessTokenHash: text(row, 'access_token_hash'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

export function toAddressRecord(row: Row): AddressRecord {
  return {
    id: requiredText(row, 'id'),
    applicationId: requiredText(row, 'application_id'),
    idAddress: text(row, 'id_address'),
    idSubdistrict: text(row, 'id_subdistrict'),
    idDistrict: text(row, 'id_district'),
    idProvince: text(row, 'id_province'),
    mailSameAsId: boolean(row, 'mail_same_as_id'),
    mailRecipient: text(row, 'mail_recipient'),
    mailAddress: text(row, 'mail_address'),
    mailSubdistrict: text(row, 'mail_subdistrict'),
    mailDistrict: text(row, 'mail_district'),
    mailProvince: text(row, 'mail_province'),
    mailPostcode: text(row, 'mail_postcode'),
    mailPhone: text(row, 'mail_phone'),
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

export function toPaymentRecord(row: Row): PaymentRecord {
  return {
    id: requiredText(row, 'id'),
    applicationId: requiredText(row, 'application_id'),
    provider: requiredText(row, 'provider'),
    transactionRef: requiredText(row, 'transaction_ref'),
    amountSatang: requiredInteger(row, 'amount'),
    sendingBank: text(row, 'sending_bank'),
    receivingBank: text(row, 'receiving_bank'),
    receiverAccountDigits: text(row, 'receiver_account_tail'),
    transactionAt: text(row, 'transaction_at'),
    receiverMatched: boolean(row, 'receiver_matched'),
    amountMatched: boolean(row, 'amount_matched'),
    verificationStatus: requiredText(row, 'verification_status') as 'VERIFIED' | 'REJECTED',
    verifiedAt: text(row, 'verified_at'),
    createdAt: requiredText(row, 'created_at'),
  };
}

export function toPaymentReviewRecord(row: Row): PaymentReviewRecord {
  return {
    applicationId: requiredText(row, 'application_id'),
    reason: requiredText(row, 'reason') as 'SLIP_UNREADABLE',
    status: requiredText(row, 'status') as PaymentReviewStatus,
    requestedAt: requiredText(row, 'requested_at'),
    resolvedAt: text(row, 'resolved_at'),
    resolvedBy: text(row, 'resolved_by'),
  };
}

export function toReceiptRecord(row: Row): ReceiptRecord {
  return {
    id: requiredText(row, 'id'),
    applicationId: requiredText(row, 'application_id'),
    paymentId: requiredText(row, 'payment_id'),
    receiptNo: requiredText(row, 'receipt_no'),
    amountSatang: requiredInteger(row, 'amount'),
    issuedAt: requiredText(row, 'issued_at'),
    emailSentAt: text(row, 'email_sent_at'),
  };
}

export function toEmailRecord(row: Row): EmailRecord {
  return {
    id: requiredText(row, 'id'),
    applicationId: requiredText(row, 'application_id'),
    type: requiredText(row, 'type') as EmailType,
    recipient: requiredText(row, 'recipient'),
    provider: requiredText(row, 'provider'),
    providerEmailId: text(row, 'provider_email_id'),
    sentAt: text(row, 'sent_at'),
    deliveredAt: text(row, 'delivered_at'),
    firstOpenedAt: text(row, 'first_opened_at'),
    firstClickedAt: text(row, 'first_clicked_at'),
    status: requiredText(row, 'status') as EmailStatus,
    createdAt: requiredText(row, 'created_at'),
    updatedAt: requiredText(row, 'updated_at'),
  };
}

export function toApplicationEventRecord(row: Row): ApplicationEventRecord {
  return {
    id: requiredText(row, 'id'),
    applicationId: requiredText(row, 'application_id'),
    eventType: requiredText(row, 'event_type'),
    metadata: metadata(row, 'metadata_json'),
    actorType: requiredText(row, 'actor_type') as ActorType,
    actorId: text(row, 'actor_id'),
    createdAt: requiredText(row, 'created_at'),
  };
}
