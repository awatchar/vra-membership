import type { AddressValues, ContactValues, IdentityValues } from './validation';
import type {
  ManualPaymentReview,
  MembershipType,
  OcrFields,
  PaymentInstructions,
  WorkflowReport,
} from '../api/types';

/**
 * Wizard state.
 *
 * A single reducer holding every field, because the requirement that going back
 * loses nothing (Issue #1 section 68) is only cheap if there is one place the
 * answers live. Per-step component state would mean each step remounting empty,
 * and the fix for that is either lifting the state up - this - or persisting it,
 * which is exactly what must not happen with these values.
 *
 * **Nothing here is ever written to `localStorage`, `sessionStorage` or
 * IndexedDB.** The state holds a citizen ID, a card image, a face image and a
 * payment slip. Storage survives the tab, is readable by any script that ever
 * runs on the origin, and is synced to disk. A refresh losing the form is the
 * price, and it is the right one; the capability token is in here too, which is
 * the other reason.
 */

export const WIZARD_STEPS = [
  'privacy',
  'card',
  'identity',
  'contact',
  'address',
  'photo',
  'membership',
  'payment',
  'payment-review',
  'confirmation',
] as const;

export type WizardStep = (typeof WIZARD_STEPS)[number];

export const STEP_TITLES: Readonly<Record<WizardStep, string>> = {
  privacy: 'ก่อนเริ่มสมัคร',
  card: 'ถ่ายภาพบัตรประชาชน',
  identity: 'ตรวจสอบข้อมูลตามบัตร',
  contact: 'ข้อมูลติดต่อ',
  address: 'ที่อยู่',
  photo: 'รูปสำหรับบัตรสมาชิก',
  membership: 'ประเภทสมาชิก',
  payment: 'ชำระค่าบำรุงสมาชิก',
  'payment-review': 'รอเจ้าหน้าที่ตรวจสอบการชำระเงิน',
  confirmation: 'สมัครเรียบร้อย',
};

/** An image held in memory only, with the object URL used to preview it. */
export interface HeldImage {
  blob: Blob;
  previewUrl: string;
}

export interface WizardState {
  step: WizardStep;
  privacyAccepted: boolean;

  /** Front of the ID card. Dropped as soon as OCR returns. */
  cardImage: HeldImage | null;
  /** True when the applicant chose to type the fields instead. */
  manualEntry: boolean;
  ocrCompleted: boolean;
  /** Face crop offered by OCR, if any. Never stored without explicit consent. */
  faceImage: HeldImage | null;

  identity: IdentityValues;
  contact: ContactValues;
  address: AddressValues;

  photoSource: 'ID_CARD' | 'UPLOAD' | null;
  /** Explicit consent to use the card's face image (Issue #1 section 61). */
  idCardPhotoConsent: boolean;
  uploadedPhoto: HeldImage | null;
  photoChecklist: { clearFace: boolean; noHat: boolean; recent: boolean };
  photoStored: boolean;

  membershipType: MembershipType | null;
  instructions: PaymentInstructions | null;

  slipImage: HeldImage | null;
  slipQrPayload: string | null;

  applicationId: string | null;
  /** In memory only, for the life of the tab. */
  accessToken: string | null;
  hasPreviousApplication: boolean;

  confirmation: WorkflowReport | null;
  manualPaymentReview: ManualPaymentReview | null;
}

export const EMPTY_IDENTITY: IdentityValues = {
  citizenId: '',
  title: '',
  firstName: '',
  lastName: '',
  firstNameEn: '',
  lastNameEn: '',
  birthDate: '',
  cardExpiryDate: '',
};

export const EMPTY_CONTACT: ContactValues = { email: '', phone: '', callsign: '' };

export const EMPTY_ADDRESS: AddressValues = {
  idAddress: '',
  idSubdistrict: '',
  idDistrict: '',
  idProvince: '',
  mailSameAsId: true,
  mailRecipient: '',
  mailAddress: '',
  mailSubdistrict: '',
  mailDistrict: '',
  mailProvince: '',
  mailPostcode: '',
  mailPhone: '',
};

export const INITIAL_STATE: WizardState = {
  step: 'privacy',
  privacyAccepted: false,
  cardImage: null,
  manualEntry: false,
  ocrCompleted: false,
  faceImage: null,
  identity: EMPTY_IDENTITY,
  contact: EMPTY_CONTACT,
  address: EMPTY_ADDRESS,
  photoSource: null,
  idCardPhotoConsent: false,
  uploadedPhoto: null,
  photoChecklist: { clearFace: false, noHat: false, recent: false },
  photoStored: false,
  membershipType: null,
  instructions: null,
  slipImage: null,
  slipQrPayload: null,
  applicationId: null,
  accessToken: null,
  hasPreviousApplication: false,
  confirmation: null,
  manualPaymentReview: null,
};

export type WizardAction =
  | { type: 'ACCEPT_PRIVACY' }
  | { type: 'GO_TO'; step: WizardStep }
  | { type: 'SET_CARD_IMAGE'; image: HeldImage | null }
  | { type: 'CHOOSE_MANUAL_ENTRY' }
  | { type: 'OCR_SUCCEEDED'; fields: OcrFields; faceImage: HeldImage | null }
  | { type: 'SET_IDENTITY'; values: Partial<IdentityValues> }
  | { type: 'SET_CONTACT'; values: Partial<ContactValues> }
  | { type: 'SET_ADDRESS'; values: Partial<AddressValues> }
  | { type: 'CHOOSE_PHOTO_SOURCE'; source: 'ID_CARD' | 'UPLOAD' }
  | { type: 'SET_ID_CARD_CONSENT'; accepted: boolean }
  | { type: 'SET_UPLOADED_PHOTO'; image: HeldImage | null }
  | { type: 'SET_PHOTO_CHECKLIST'; values: Partial<WizardState['photoChecklist']> }
  | { type: 'PHOTO_STORED' }
  | { type: 'CHOOSE_MEMBERSHIP'; membershipType: MembershipType }
  | { type: 'SET_INSTRUCTIONS'; instructions: PaymentInstructions }
  | { type: 'SET_SLIP'; image: HeldImage | null; qrPayload: string | null }
  | {
      type: 'APPLICATION_CREATED';
      applicationId: string;
      accessToken: string;
      hasPrevious: boolean;
    }
  | { type: 'CONFIRMED'; report: WorkflowReport }
  | { type: 'MANUAL_PAYMENT_REVIEW_REQUESTED'; review: ManualPaymentReview };

/** Frees an object URL, so a discarded preview does not pin its blob in memory. */
function release(image: HeldImage | null): void {
  if (image && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(image.previewUrl);
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'ACCEPT_PRIVACY':
      return { ...state, privacyAccepted: true, step: 'card' };

    case 'GO_TO':
      return { ...state, step: action.step };

    case 'SET_CARD_IMAGE':
      if (state.cardImage !== action.image) release(state.cardImage);
      return { ...state, cardImage: action.image };

    case 'CHOOSE_MANUAL_ENTRY':
      // The card image has no further use once the applicant is typing the
      // fields, so it goes now rather than at the end of the wizard.
      release(state.cardImage);
      return { ...state, cardImage: null, manualEntry: true, step: 'identity' };

    case 'OCR_SUCCEEDED': {
      // The card image is dropped the moment the fields come back. Keeping it
      // for the rest of the wizard would mean holding the whole card in memory
      // for no purpose (Issue #1 section 6).
      release(state.cardImage);
      release(state.faceImage);

      const { fields } = action;
      return {
        ...state,
        cardImage: null,
        ocrCompleted: true,
        faceImage: action.faceImage,
        // Treated strictly as a pre-fill: the applicant reviews every field on
        // the next step, and nothing is confirmed until they submit it
        // (Issue #1 section 7).
        identity: {
          citizenId: fields.citizenId,
          title: fields.titleTh ?? '',
          firstName: fields.firstNameTh ?? '',
          lastName: fields.lastNameTh ?? '',
          firstNameEn: fields.firstNameEn ?? '',
          lastNameEn: fields.lastNameEn ?? '',
          birthDate: fields.birthDate ?? '',
          cardExpiryDate: fields.cardExpiryDate ?? '',
        },
        address: {
          ...state.address,
          idAddress: fields.addressLine ?? state.address.idAddress,
          idSubdistrict: fields.subdistrict ?? state.address.idSubdistrict,
          idDistrict: fields.district ?? state.address.idDistrict,
          idProvince: fields.province ?? state.address.idProvince,
        },
        step: 'identity',
      };
    }

    case 'SET_IDENTITY':
      return { ...state, identity: { ...state.identity, ...action.values } };

    case 'SET_CONTACT':
      return { ...state, contact: { ...state.contact, ...action.values } };

    case 'SET_ADDRESS':
      return { ...state, address: { ...state.address, ...action.values } };

    case 'CHOOSE_PHOTO_SOURCE':
      return {
        ...state,
        photoSource: action.source,
        // Switching away from the card clears the consent, so it can never
        // apply to a choice the applicant did not make.
        idCardPhotoConsent: action.source === 'ID_CARD' ? state.idCardPhotoConsent : false,
      };

    case 'SET_ID_CARD_CONSENT':
      return { ...state, idCardPhotoConsent: action.accepted };

    case 'SET_UPLOADED_PHOTO':
      if (state.uploadedPhoto !== action.image) release(state.uploadedPhoto);
      return { ...state, uploadedPhoto: action.image, photoStored: false };

    case 'SET_PHOTO_CHECKLIST':
      return { ...state, photoChecklist: { ...state.photoChecklist, ...action.values } };

    case 'PHOTO_STORED':
      return { ...state, photoStored: true, step: 'membership' };

    case 'CHOOSE_MEMBERSHIP':
      return { ...state, membershipType: action.membershipType };

    case 'SET_INSTRUCTIONS':
      return { ...state, instructions: action.instructions, step: 'payment' };

    case 'SET_SLIP':
      if (state.slipImage !== action.image) release(state.slipImage);
      return { ...state, slipImage: action.image, slipQrPayload: action.qrPayload };

    case 'APPLICATION_CREATED':
      return {
        ...state,
        applicationId: action.applicationId,
        accessToken: action.accessToken,
        hasPreviousApplication: action.hasPrevious,
        step: 'contact',
      };

    case 'CONFIRMED': {
      // The slip is finished with. It is the last sensitive image the wizard
      // holds, and the confirmation page has no use for it.
      release(state.slipImage);
      return { ...state, slipImage: null, confirmation: action.report, step: 'confirmation' };
    }

    case 'MANUAL_PAYMENT_REVIEW_REQUESTED': {
      release(state.slipImage);
      return {
        ...state,
        slipImage: null,
        slipQrPayload: null,
        manualPaymentReview: action.review,
        step: 'payment-review',
      };
    }
  }
}

/** Whether the photo step has everything it needs to submit. */
export function canSubmitPhoto(state: WizardState): boolean {
  const checklist = state.photoChecklist;
  const confirmed = checklist.clearFace && checklist.noHat && checklist.recent;
  if (!confirmed) return false;
  if (state.photoSource === 'ID_CARD') return Boolean(state.faceImage) && state.idCardPhotoConsent;
  return state.photoSource === 'UPLOAD' && Boolean(state.uploadedPhoto);
}

/**
 * The step to return to from `step`, or null when there is nowhere to go.
 *
 * `confirmation` is terminal: the payment is made and the application is
 * submitted, so there is nothing behind it to change.
 */
export function previousStep(state: WizardState): WizardStep | null {
  switch (state.step) {
    case 'privacy':
    case 'confirmation':
    case 'payment-review':
      return null;
    case 'card':
      return 'privacy';
    case 'identity':
      return 'card';
    case 'contact':
      // The application exists by now and its identity cannot be changed, so
      // going back to `identity` would offer an edit that does nothing.
      return null;
    case 'address':
      return 'contact';
    case 'photo':
      return 'address';
    case 'membership':
      return 'photo';
    case 'payment':
      return 'membership';
  }
}

/**
 * Progress for the step indicator: 1-based position and the total.
 *
 * Manual review is an alternative final outcome to confirmation, not an extra
 * step every applicant must complete. Both therefore occupy step 9.
 */
export function stepPosition(step: WizardStep): { index: number; total: number } {
  const index =
    step === 'payment-review' || step === 'confirmation' ? 9 : WIZARD_STEPS.indexOf(step) + 1;
  return { index, total: 9 };
}
