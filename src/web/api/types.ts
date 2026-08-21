/**
 * Wire shapes of the applicant-facing API.
 *
 * Written out by hand rather than imported from `src/worker` on purpose. The two
 * halves are built and deployed separately, and importing worker types into the
 * browser bundle is how a server-only module - and the secret it reads - ends up
 * in client code by accident.
 */

export type MembershipType = 'FIVE_YEAR' | 'LIFETIME';
export type PhotoSource = 'ID_CARD' | 'UPLOAD';

export interface PublicConfig {
  /** Absent when Turnstile is not configured, e.g. local development. */
  turnstileSiteKey: string | null;
  environment: string;
}

export interface OcrFields {
  citizenId: string;
  titleTh: string | null;
  firstNameTh: string | null;
  lastNameTh: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  birthDate: string | null;
  cardExpiryDate: string | null;
  addressLine: string | null;
  subdistrict: string | null;
  district: string | null;
  province: string | null;
  faceImage: { contentType: string; base64: string } | null;
}

export interface OcrResponse {
  data: OcrFields;
}

export interface ApplicationView {
  id: string;
  referenceNo: string | null;
  status: string;
  citizenIdTail: string;
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
  hasPhoto: boolean;
  photoSource: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreatedApplication {
  application: ApplicationView;
  accessToken: string;
  hasPreviousApplication: boolean;
}

export interface AddressPayload {
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
  mailPostcode: string;
  mailPhone: string | null;
}

export interface UpdatePayload {
  phone?: string | null;
  email?: string | null;
  callsign?: string | null;
  membershipType?: MembershipType;
  address?: AddressPayload;
}

export interface StoredPhoto {
  stored: boolean;
  source: PhotoSource;
  width: number;
  height: number;
}

export interface PaymentInstructions {
  membershipType: MembershipType;
  membershipLabel: string;
  amountSatang: number;
  amountBaht: string;
  bankName: string;
  accountName: string;
  accountNumber: string;
  qrPayload: string | null;
}

export type WorkflowStep =
  | 'APPLICATION_NUMBER'
  | 'RECEIPT'
  | 'RECEIPT_EMAIL'
  | 'SUBMISSION'
  | 'MANAGER_EMAIL';

export type StepState = 'DONE' | 'ALREADY_DONE' | 'FAILED' | 'SKIPPED';

export interface WorkflowReport {
  applicationId: string;
  referenceNo: string | null;
  receiptNo: string | null;
  status: string;
  steps: Record<WorkflowStep, StepState>;
  complete: boolean;
}

export interface PaymentVerified extends WorkflowReport {
  verified: true;
  amountSatang: number;
  amountBaht: string;
}
