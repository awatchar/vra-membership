import { describe, expect, it } from 'vitest';
import {
  INITIAL_STATE,
  canSubmitPhoto,
  previousStep,
  stepPosition,
  wizardReducer,
} from '../../src/web/state/wizard';
import type { HeldImage, WizardState } from '../../src/web/state/wizard';
import type { OcrFields } from '../../src/web/api/types';

/** Synthetic OCR output. Every value is invented. */
const OCR_FIELDS: OcrFields = {
  citizenId: '1234567890121',
  titleTh: 'นาย',
  firstNameTh: 'ทดสอบ',
  lastNameTh: 'ระบบสมัคร',
  firstNameEn: 'Thodsob',
  lastNameEn: 'Rabobsamak',
  birthDate: '1990-01-15',
  cardExpiryDate: '2032-01-14',
  addressLine: '99/9 หมู่ 9',
  subdistrict: 'ตำบลทดสอบ',
  district: 'อำเภอทดสอบ',
  province: 'จังหวัดทดสอบ',
  faceImage: null,
};

function image(name = 'x'): HeldImage {
  return { blob: new Blob([name]), previewUrl: `blob:${name}` };
}

function reduce(
  state: WizardState,
  ...actions: Parameters<typeof wizardReducer>[1][]
): WizardState {
  return actions.reduce(wizardReducer, state);
}

describe('moving through the wizard', () => {
  it('starts on the privacy notice with nothing filled in', () => {
    expect(INITIAL_STATE.step).toBe('privacy');
    expect(INITIAL_STATE.privacyAccepted).toBe(false);
    expect(INITIAL_STATE.identity.citizenId).toBe('');
  });

  it('reports its position for the step indicator', () => {
    expect(stepPosition('privacy')).toEqual({ index: 1, total: 9 });
    expect(stepPosition('payment-review')).toEqual({ index: 9, total: 9 });
    expect(stepPosition('confirmation')).toEqual({ index: 9, total: 9 });
  });

  it('cannot go back from the privacy notice or the confirmation', () => {
    expect(previousStep(INITIAL_STATE)).toBeNull();
    expect(previousStep({ ...INITIAL_STATE, step: 'confirmation' })).toBeNull();
  });

  it('offers no way back from the contact step', () => {
    // The application exists by then and its identity cannot be changed, so a
    // back button there would offer an edit that does nothing.
    expect(previousStep({ ...INITIAL_STATE, step: 'contact' })).toBeNull();
    expect(previousStep({ ...INITIAL_STATE, step: 'address' })).toBe('contact');
    expect(previousStep({ ...INITIAL_STATE, step: 'payment' })).toBe('membership');
  });
});

describe('OCR output is a pre-fill', () => {
  it('fills the identity and address fields and moves to the review step', () => {
    const state = reduce(
      INITIAL_STATE,
      { type: 'ACCEPT_PRIVACY' },
      { type: 'OCR_SUCCEEDED', fields: OCR_FIELDS, faceImage: image('face') },
    );

    expect(state.step).toBe('identity');
    expect(state.ocrCompleted).toBe(true);
    expect(state.identity.firstName).toBe('ทดสอบ');
    expect(state.address.idProvince).toBe('จังหวัดทดสอบ');
  });

  it('drops the card image as soon as the fields come back', () => {
    const state = reduce(
      INITIAL_STATE,
      { type: 'SET_CARD_IMAGE', image: image('card') },
      { type: 'OCR_SUCCEEDED', fields: OCR_FIELDS, faceImage: null },
    );

    // The card has no further use, and holding it would mean keeping the whole
    // document in memory for the rest of the wizard (Issue #1 section 6).
    expect(state.cardImage).toBeNull();
  });

  it('keeps an edit the applicant made afterwards', () => {
    const state = reduce(
      INITIAL_STATE,
      { type: 'OCR_SUCCEEDED', fields: OCR_FIELDS, faceImage: null },
      { type: 'SET_IDENTITY', values: { firstName: 'แก้ไขแล้ว' } },
    );

    expect(state.identity.firstName).toBe('แก้ไขแล้ว');
    expect(state.identity.lastName).toBe('ระบบสมัคร');
  });

  it('drops the card image when the applicant chooses to type instead', () => {
    const state = reduce(
      INITIAL_STATE,
      { type: 'SET_CARD_IMAGE', image: image('card') },
      { type: 'CHOOSE_MANUAL_ENTRY' },
    );

    expect(state.cardImage).toBeNull();
    expect(state.manualEntry).toBe(true);
    expect(state.step).toBe('identity');
  });
});

describe('going back keeps every answer', () => {
  it('preserves all three forms across a round trip', () => {
    const filled = reduce(
      INITIAL_STATE,
      { type: 'SET_IDENTITY', values: { firstName: 'ทดสอบ', citizenId: '1234567890121' } },
      { type: 'SET_CONTACT', values: { email: 'a@example.test', phone: '0812345678' } },
      { type: 'SET_ADDRESS', values: { idAddress: '99/9', mailPostcode: '10200' } },
      { type: 'GO_TO', step: 'photo' },
    );

    const returned = reduce(
      filled,
      { type: 'GO_TO', step: 'address' },
      { type: 'GO_TO', step: 'photo' },
    );

    expect(returned.identity.firstName).toBe('ทดสอบ');
    expect(returned.contact.email).toBe('a@example.test');
    expect(returned.address.mailPostcode).toBe('10200');
  });
});

describe('the member photo', () => {
  const ready: WizardState = {
    ...INITIAL_STATE,
    step: 'photo',
    faceImage: image('face'),
    uploadedPhoto: image('upload'),
    photoChecklist: { clearFace: true, noHat: true, recent: true },
  };

  it('cannot be submitted from the card without explicit consent', () => {
    const chosen = wizardReducer(ready, { type: 'CHOOSE_PHOTO_SOURCE', source: 'ID_CARD' });

    // Issue #1 section 61: the face from the card is never used without the
    // applicant saying so.
    expect(canSubmitPhoto(chosen)).toBe(false);

    const consented = wizardReducer(chosen, { type: 'SET_ID_CARD_CONSENT', accepted: true });
    expect(canSubmitPhoto(consented)).toBe(true);
  });

  it('clears the consent when the applicant switches to an upload', () => {
    const state = reduce(
      ready,
      { type: 'CHOOSE_PHOTO_SOURCE', source: 'ID_CARD' },
      { type: 'SET_ID_CARD_CONSENT', accepted: true },
      { type: 'CHOOSE_PHOTO_SOURCE', source: 'UPLOAD' },
    );

    // Otherwise the consent would survive a choice the applicant undid, and a
    // later switch back would carry it silently.
    expect(state.idCardPhotoConsent).toBe(false);
  });

  it('needs all three checklist items, not just one', () => {
    const partial: WizardState = {
      ...ready,
      photoSource: 'UPLOAD',
      photoChecklist: { clearFace: true, noHat: false, recent: true },
    };

    expect(canSubmitPhoto(partial)).toBe(false);
    expect(
      canSubmitPhoto({
        ...partial,
        photoChecklist: { clearFace: true, noHat: true, recent: true },
      }),
    ).toBe(true);
  });

  it('needs the full image for the chosen source', () => {
    expect(canSubmitPhoto({ ...ready, photoSource: 'UPLOAD', uploadedPhoto: null })).toBe(false);
    expect(canSubmitPhoto({ ...ready, photoSource: 'ID_CARD', faceImage: null })).toBe(false);
  });

  it('invalidates a stored photo when a new one is chosen', () => {
    const state = reduce(
      { ...ready, photoStored: true },
      { type: 'SET_UPLOADED_PHOTO', image: image('new') },
    );

    expect(state.photoStored).toBe(false);
  });
});

describe('the payment slip', () => {
  it('keeps only the payload when the QR was read', () => {
    const state = wizardReducer(
      { ...INITIAL_STATE, step: 'payment' },
      { type: 'SET_SLIP', image: null, qrPayload: '00020101' },
    );

    // The preferred path: the image never leaves the device, so it is not even
    // held (Issue #1 section 18).
    expect(state.slipImage).toBeNull();
    expect(state.slipQrPayload).toBe('00020101');
  });

  it('holds the image only as a fallback', () => {
    const state = wizardReducer(
      { ...INITIAL_STATE, step: 'payment' },
      { type: 'SET_SLIP', image: image('slip'), qrPayload: null },
    );

    expect(state.slipImage).not.toBeNull();
    expect(state.slipQrPayload).toBeNull();
  });

  it('releases the slip once the application is confirmed', () => {
    const state = reduce(
      { ...INITIAL_STATE, step: 'payment' },
      { type: 'SET_SLIP', image: image('slip'), qrPayload: null },
      {
        type: 'CONFIRMED',
        report: {
          applicationId: 'a',
          referenceNo: 'VRA-2569-000001',
          receiptNo: 'VRA-RC-2569-000001',
          status: 'MANAGER_NOTIFIED',
          steps: {
            APPLICATION_NUMBER: 'DONE',
            RECEIPT: 'DONE',
            RECEIPT_EMAIL: 'DONE',
            SUBMISSION: 'DONE',
            MANAGER_EMAIL: 'DONE',
          },
          complete: true,
        },
      },
    );

    expect(state.slipImage).toBeNull();
    expect(state.step).toBe('confirmation');
    expect(state.confirmation?.referenceNo).toBe('VRA-2569-000001');
  });

  it('releases an unreadable slip and moves to the durable manual-review result', () => {
    const state = reduce(
      { ...INITIAL_STATE, step: 'payment' },
      { type: 'SET_SLIP', image: image('unclear-slip'), qrPayload: null },
      {
        type: 'MANUAL_PAYMENT_REVIEW_REQUESTED',
        review: {
          verified: false,
          manualReview: true,
          status: 'PENDING',
          notificationSent: true,
          message: 'ส่งคำขอตรวจสอบแล้ว',
        },
      },
    );

    expect(state.slipImage).toBeNull();
    expect(state.slipQrPayload).toBeNull();
    expect(state.step).toBe('payment-review');
    expect(state.manualPaymentReview?.status).toBe('PENDING');
  });
});

describe('the capability token', () => {
  it('is held in state and moves the wizard on', () => {
    const state = wizardReducer(
      { ...INITIAL_STATE, step: 'identity' },
      {
        type: 'APPLICATION_CREATED',
        applicationId: 'application-1',
        accessToken: 'token-1',
        hasPrevious: true,
      },
    );

    expect(state.applicationId).toBe('application-1');
    expect(state.accessToken).toBe('token-1');
    expect(state.hasPreviousApplication).toBe(true);
    expect(state.step).toBe('contact');
  });
});
