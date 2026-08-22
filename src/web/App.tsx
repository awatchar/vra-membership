import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ApiRequestError, api } from './api/client';
import type { AssociationContact, PublicConfig } from './api/types';
import { Alert } from './components/Alert';
import { Button } from './components/Button';
import { SiteFooter } from './components/SiteFooter';
import { SiteHeader } from './components/SiteHeader';
import { StepFrame } from './components/StepFrame';
import { TurnstileGate } from './components/TurnstileGate';
import { base64ToBlob, downscale } from './lib/image';
import { decodeQrFromImage, looksLikeSlipPayload } from './lib/qr';
import { INITIAL_STATE, canSubmitPhoto, previousStep, wizardReducer } from './state/wizard';
import type { HeldImage } from './state/wizard';
import {
  digitsOnly,
  hasErrors,
  validateAddress,
  validateContact,
  validateIdentity,
} from './state/validation';
import type { AddressField, ContactField, FieldErrors, IdentityField } from './state/validation';
import { AddressStep } from './steps/AddressStep';
import { CardStep } from './steps/CardStep';
import { ConfirmationStep } from './steps/ConfirmationStep';
import { ContactStep } from './steps/ContactStep';
import { IdentityStep } from './steps/IdentityStep';
import { MembershipStep } from './steps/MembershipStep';
import { PaymentStep } from './steps/PaymentStep';
import { PaymentReviewStep } from './steps/PaymentReviewStep';
import { PhotoStep } from './steps/PhotoStep';
import { PrivacyStep } from './steps/PrivacyStep';

/**
 * The applicant wizard.
 *
 * Two decisions here are worth knowing before changing anything.
 *
 * **Nothing is persisted.** No `localStorage`, no `sessionStorage`, no service
 * worker cache. The state holds a citizen ID, a card image, a face image, a
 * payment slip and the capability token that protects the whole application.
 * Storage outlives the tab, is readable by any script that ever runs on the
 * origin, and is written to disk. A refresh losing the form is the cost, and it
 * is the right trade.
 *
 * **Every request goes through `run`, which refuses to start a second one while
 * one is in flight.** A disabled button is a hint to a person; it is not a lock.
 * Two taps on a slow connection can both dispatch before React re-renders, and
 * the two things that must never happen twice - creating an application, and
 * verifying a payment - are exactly the two the applicant is most likely to
 * double-tap.
 */

/**
 * Shown before `/api/config` answers, and if it never does.
 *
 * Only the name, because that is the one field the header cannot do without.
 * The contact rows stay empty rather than guessing at a phone number.
 */
const FALLBACK_ASSOCIATION: AssociationContact = {
  name: 'สมาคมนักวิทยุอาสาสมัคร',
  postalAddress: null,
  email: null,
  lineId: null,
  phone: null,
};

/** Blob plus its preview URL, tracked together so the URL can be revoked. */
function hold(blob: Blob): HeldImage {
  return { blob, previewUrl: URL.createObjectURL(blob) };
}

function messageFor(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'เกิดข้อผิดพลาดที่ไม่คาดคิด กรุณาลองอีกครั้ง';
}

export function App() {
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_STATE);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const [identityErrors, setIdentityErrors] = useState<FieldErrors<IdentityField>>({});
  const [contactErrors, setContactErrors] = useState<FieldErrors<ContactField>>({});
  const [addressErrors, setAddressErrors] = useState<FieldErrors<AddressField>>({});
  const [confirmingIdAddress, setConfirmingIdAddress] = useState(false);

  const [usedImageFallback, setUsedImageFallback] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileRound, setTurnstileRound] = useState(0);

  /**
   * The single-flight lock.
   *
   * A ref, not state: it has to be readable and writable synchronously within
   * one event, and a state update would not be visible to a second click that
   * landed in the same tick.
   */
  const inFlight = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const resetTurnstile = useCallback(() => {
    setTurnstileToken(null);
    setTurnstileRound((round) => round + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    api
      .config(controller.signal)
      .then(setConfig)
      // A missing config is not fatal: no site key means no widget, and the
      // server still decides whether a token was required.
      .catch(() =>
        setConfig({
          turnstileSiteKey: null,
          environment: 'unknown',
          association: FALLBACK_ASSOCIATION,
        }),
      );
    return () => controller.abort();
  }, []);

  // Moves focus to the heading on every step change. On a single-page wizard
  // nothing announces the change otherwise, so a screen reader user hears
  // silence after pressing "next".
  useEffect(() => {
    headingRef.current?.focus();
  }, [state.step]);

  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      try {
        await task();
      } catch (caught) {
        setError(messageFor(caught));
        // A Turnstile token is single-use, so the next attempt needs a fresh
        // challenge or it will fail again for a reason the applicant cannot see.
        resetTurnstile();
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [resetTurnstile],
  );

  const token = state.accessToken;

  /* ------------------------------------------------------------- actions --- */

  const readCard = (file: File) =>
    run(async () => {
      const image = await downscale(file);
      const response = await api.readIdCard(image, turnstileToken);
      const face = response.data.faceImage;

      dispatch({
        type: 'OCR_SUCCEEDED',
        fields: response.data,
        faceImage: face ? hold(base64ToBlob(face.base64, face.contentType)) : null,
      });
      resetTurnstile();
    });

  const submitIdentity = () => {
    const errors = validateIdentity(state.identity);
    setIdentityErrors(errors);
    if (hasErrors(errors)) return;

    void run(async () => {
      const created = await api.createApplication(
        {
          citizenId: digitsOnly(state.identity.citizenId),
          title: state.identity.title.trim() || null,
          firstName: state.identity.firstName.trim() || null,
          lastName: state.identity.lastName.trim() || null,
          firstNameEn: state.identity.firstNameEn.trim() || null,
          lastNameEn: state.identity.lastNameEn.trim() || null,
          birthDate: state.identity.birthDate || null,
          cardExpiryDate: state.identity.cardExpiryDate || null,
        },
        turnstileToken,
      );

      dispatch({
        type: 'APPLICATION_CREATED',
        applicationId: created.application.id,
        accessToken: created.accessToken,
        hasPrevious: created.hasPreviousApplication,
      });
      // The application challenge has now been spent. Leaving it in state
      // would let a later guarded step briefly see and submit a stale token
      // before its own widget finishes rendering.
      resetTurnstile();
    });
  };

  const submitContact = () => {
    const errors = validateContact(state.contact);
    setContactErrors(errors);
    if (hasErrors(errors) || !state.applicationId || !token) return;

    void run(async () => {
      await api.update(
        state.applicationId!,
        {
          email: state.contact.email.trim(),
          phone: state.contact.phone.trim(),
          callsign: state.contact.callsign.trim() || null,
        },
        token,
      );
      dispatch({ type: 'GO_TO', step: 'address' });
    });
  };

  const saveAddress = () => {
    if (!state.applicationId || !token) return;
    const values = state.address;
    void run(async () => {
      await api.update(
        state.applicationId!,
        {
          address: {
            idAddress: values.idAddress.trim() || null,
            idSubdistrict: values.idSubdistrict.trim() || null,
            idDistrict: values.idDistrict.trim() || null,
            idProvince: values.idProvince.trim() || null,
            mailSameAsId: values.mailSameAsId,
            mailRecipient: values.mailRecipient.trim() || null,
            mailAddress: values.mailAddress.trim() || null,
            mailSubdistrict: values.mailSubdistrict.trim() || null,
            mailDistrict: values.mailDistrict.trim() || null,
            mailProvince: values.mailProvince.trim() || null,
            mailPostcode: digitsOnly(values.mailPostcode),
            mailPhone: values.mailPhone.trim() || null,
          },
        },
        token,
      );
      dispatch({ type: 'GO_TO', step: 'photo' });
    });
  };

  const submitAddress = () => {
    const errors = validateAddress(state.address);
    setAddressErrors(errors);
    if (hasErrors(errors) || !state.applicationId || !token) return;

    if (state.address.mailSameAsId) {
      setConfirmingIdAddress(true);
      return;
    }

    saveAddress();
  };

  const confirmIdAddress = () => {
    setConfirmingIdAddress(false);
    saveAddress();
  };

  const chooseUpload = (file: File) =>
    run(async () => {
      const scaled = await downscale(file, 1400);
      resetTurnstile();
      dispatch({ type: 'SET_UPLOADED_PHOTO', image: hold(scaled) });
    });

  const chooseSource = (source: 'ID_CARD' | 'UPLOAD') => {
    resetTurnstile();
    dispatch({ type: 'CHOOSE_PHOTO_SOURCE', source });
  };

  const submitPhoto = () => {
    const photo = state.photoSource === 'ID_CARD' ? state.faceImage : state.uploadedPhoto;
    const requiresTurnstile = Boolean(config?.turnstileSiteKey);
    if (
      !canSubmitPhoto(state) ||
      !state.applicationId ||
      !token ||
      !photo ||
      (requiresTurnstile && !turnstileToken)
    )
      return;
    const source = state.photoSource!;

    void run(async () => {
      await api.storePhoto(state.applicationId!, photo.blob, source, token, turnstileToken);
      resetTurnstile();
      dispatch({ type: 'PHOTO_STORED' });
    });
  };

  const submitMembership = () => {
    if (!state.membershipType || !state.applicationId || !token) return;

    void run(async () => {
      await api.update(state.applicationId!, { membershipType: state.membershipType! }, token);
      const instructions = await api.paymentInstructions(state.applicationId!, token);
      dispatch({ type: 'SET_INSTRUCTIONS', instructions });
    });
  };

  const readSlip = (file: File) => {
    setError(null);
    setUsedImageFallback(false);
    setReading(true);

    void (async () => {
      try {
        const scaled = await downscale(file, 1600);
        const payload = await decodeQrFromImage(scaled);

        if (payload && looksLikeSlipPayload(payload)) {
          // The preferred path: only the payload is kept, and the image is
          // dropped here rather than held until submit.
          dispatch({ type: 'SET_SLIP', image: null, qrPayload: payload });
        } else {
          dispatch({ type: 'SET_SLIP', image: hold(scaled), qrPayload: null });
          setUsedImageFallback(true);
        }
      } catch {
        setError('ไม่สามารถอ่านไฟล์นี้ได้ กรุณาเลือกภาพสลิปอีกครั้ง');
      } finally {
        setReading(false);
      }
    })();
  };

  const submitPayment = () => {
    if (!state.applicationId || !token) return;
    const evidence = state.slipQrPayload
      ? { qrPayload: state.slipQrPayload }
      : state.slipImage
        ? { slip: state.slipImage.blob }
        : null;
    if (!evidence) return;

    void run(async () => {
      const result = await api.verifyPayment(state.applicationId!, evidence, token, turnstileToken);
      resetTurnstile();
      if ('manualReview' in result) {
        dispatch({ type: 'MANUAL_PAYMENT_REVIEW_REQUESTED', review: result });
      } else {
        dispatch({ type: 'CONFIRMED', report: result });
      }
    });
  };

  const retryOutstanding = () => {
    if (!state.applicationId || !token) return;
    void run(async () => {
      const { confirmation } = await api.finalize(state.applicationId!, token);
      dispatch({ type: 'CONFIRMED', report: confirmation });
    });
  };

  /* -------------------------------------------------------------- render --- */

  const siteKey = config?.turnstileSiteKey ?? null;
  const gate = (action: string) => (
    <TurnstileGate
      siteKey={siteKey}
      action={action}
      resetKey={turnstileRound}
      onToken={setTurnstileToken}
    />
  );

  const back = previousStep(state);

  // Until `/api/config` answers, the name falls back to the constant rather
  // than rendering an empty header - a page that briefly claims to belong to
  // nobody is worse than one that is momentarily generic.
  const association = config?.association ?? FALLBACK_ASSOCIATION;

  return (
    <div className="vra-page">
      <SiteHeader associationName={association.name} subtitle="ระบบรับสมัครสมาชิก" />

      <main className="vra-main">
        <StepFrame
          step={state.step}
          headingRef={headingRef}
          footer={
            back ? (
              <Button
                variant="quiet"
                onClick={() => {
                  resetTurnstile();
                  dispatch({ type: 'GO_TO', step: back });
                }}
                disabled={busy}
              >
                ย้อนกลับ
              </Button>
            ) : null
          }
        >
          {state.step === 'privacy' ? (
            <PrivacyStep onAccept={() => dispatch({ type: 'ACCEPT_PRIVACY' })} />
          ) : null}

          {state.step === 'card' ? (
            <CardStep
              busy={busy}
              error={error}
              onSelect={(file) => void readCard(file)}
              onManualEntry={() => {
                resetTurnstile();
                dispatch({ type: 'CHOOSE_MANUAL_ENTRY' });
              }}
              turnstileSlot={gate('ocr')}
            />
          ) : null}

          {state.step === 'identity' ? (
            <IdentityStep
              values={state.identity}
              errors={identityErrors}
              fromOcr={state.ocrCompleted}
              busy={busy}
              submitError={error}
              duplicateWarning={state.hasPreviousApplication}
              onChange={(values) => dispatch({ type: 'SET_IDENTITY', values })}
              onSubmit={submitIdentity}
              turnstileSlot={gate('application')}
            />
          ) : null}

          {state.step === 'contact' ? (
            <ContactStep
              values={state.contact}
              errors={contactErrors}
              busy={busy}
              submitError={error}
              onChange={(values) => dispatch({ type: 'SET_CONTACT', values })}
              onSubmit={submitContact}
            />
          ) : null}

          {state.step === 'address' ? (
            <AddressStep
              values={state.address}
              errors={addressErrors}
              busy={busy}
              submitError={error}
              fromOcr={state.ocrCompleted}
              onChange={(values) => dispatch({ type: 'SET_ADDRESS', values })}
              onSubmit={submitAddress}
              confirmingSameAddress={confirmingIdAddress}
              onCancelSameAddress={() => setConfirmingIdAddress(false)}
              onConfirmSameAddress={confirmIdAddress}
            />
          ) : null}

          {state.step === 'photo' ? (
            <PhotoStep
              state={state}
              busy={busy}
              error={error}
              readyForHumanCheck={canSubmitPhoto(state)}
              canSubmit={canSubmitPhoto(state) && (!siteKey || turnstileToken !== null)}
              onChooseSource={chooseSource}
              onConsentChange={(accepted) => {
                resetTurnstile();
                dispatch({ type: 'SET_ID_CARD_CONSENT', accepted });
              }}
              onUpload={(file) => void chooseUpload(file)}
              onChecklistChange={(values) => {
                resetTurnstile();
                dispatch({ type: 'SET_PHOTO_CHECKLIST', values });
              }}
              onSubmit={submitPhoto}
              turnstileSlot={gate('member_photo')}
            />
          ) : null}

          {state.step === 'membership' ? (
            <MembershipStep
              selected={state.membershipType}
              busy={busy}
              error={error}
              onSelect={(membershipType) => dispatch({ type: 'CHOOSE_MEMBERSHIP', membershipType })}
              onSubmit={submitMembership}
            />
          ) : null}

          {state.step === 'payment' && state.instructions ? (
            <PaymentStep
              instructions={state.instructions}
              busy={busy}
              reading={reading}
              error={error}
              qrPayload={state.slipQrPayload}
              usedImageFallback={usedImageFallback}
              onSlipSelected={readSlip}
              onSubmit={submitPayment}
              turnstileSlot={gate('payment')}
            />
          ) : null}

          {state.step === 'confirmation' && state.confirmation ? (
            <ConfirmationStep
              report={state.confirmation}
              busy={busy}
              error={error}
              onRetry={retryOutstanding}
            />
          ) : null}

          {state.step === 'payment-review' && state.manualPaymentReview ? (
            <PaymentReviewStep
              review={state.manualPaymentReview}
              onRetryAutomatic={() => dispatch({ type: 'GO_TO', step: 'payment' })}
            />
          ) : null}

          {state.step === 'payment' && !state.instructions ? (
            <Alert tone="error">
              <p>ไม่พบข้อมูลการชำระเงิน กรุณาย้อนกลับไปเลือกประเภทสมาชิกอีกครั้ง</p>
            </Alert>
          ) : null}
        </StepFrame>
      </main>

      <SiteFooter contact={association} />
    </div>
  );
}
