import type { ReactNode } from 'react';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { ImagePicker } from '../components/ImagePicker';
import type { HeldImage, WizardState } from '../state/wizard';

/**
 * Choosing the member photo (Issue #1 sections 11, 12 and 61; owner update #52).
 *
 * The card's face image is offered, never assumed. Selecting it reveals a
 * separate consent checkbox, and the submit button stays disabled until that box
 * is ticked - section 61 forbids using the face from the card without the
 * applicant knowing. Switching to an upload clears the consent, so it can never
 * apply to a choice that was undone.
 *
 * The selected frame is previewed and sent whole. Issue #52 deliberately
 * removes the crop control for both sources; proportional downscaling may make
 * a large upload smaller but never removes pixels from its edges.
 *
 * The three-item checklist is the section 12 confirmation. It is three boxes
 * rather than one because "I confirm this photo is suitable" is a box people tick
 * without reading; "the face is clear", "no hat or sunglasses" and "taken
 * recently" are three specific things to actually look at.
 */

export interface PhotoStepProps {
  state: WizardState;
  busy: boolean;
  error: string | null;
  readyForHumanCheck: boolean;
  canSubmit: boolean;
  onChooseSource: (source: 'ID_CARD' | 'UPLOAD') => void;
  onConsentChange: (accepted: boolean) => void;
  onUpload: (file: File) => void;
  onChecklistChange: (values: Partial<WizardState['photoChecklist']>) => void;
  onSubmit: () => void;
  turnstileSlot: ReactNode;
}

/** The full image selected for storage, whichever source was chosen. */
function sourceImage(state: WizardState): HeldImage | null {
  return state.photoSource === 'ID_CARD' ? state.faceImage : state.uploadedPhoto;
}

export function PhotoStep({
  state,
  busy,
  error,
  readyForHumanCheck,
  canSubmit,
  onChooseSource,
  onConsentChange,
  onUpload,
  onChecklistChange,
  onSubmit,
  turnstileSlot,
}: PhotoStepProps) {
  const image = sourceImage(state);
  const checklist = state.photoChecklist;

  return (
    <>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <fieldset className="vra-fieldset">
        <legend className="vra-field__label">เลือกที่มาของรูป</legend>

        {state.faceImage ? (
          <label className="vra-radio">
            <input
              type="radio"
              name="photo-source"
              checked={state.photoSource === 'ID_CARD'}
              onChange={() => onChooseSource('ID_CARD')}
            />
            <span>ใช้ภาพใบหน้าจากบัตรประชาชน</span>
          </label>
        ) : null}

        <label className="vra-radio">
          <input
            type="radio"
            name="photo-source"
            checked={state.photoSource === 'UPLOAD'}
            onChange={() => onChooseSource('UPLOAD')}
          />
          <span>อัปโหลดรูปใหม่</span>
        </label>
      </fieldset>

      {state.photoSource === 'ID_CARD' ? (
        <label className="vra-checkbox vra-checkbox--emphasis">
          <input
            type="checkbox"
            checked={state.idCardPhotoConsent}
            onChange={(event) => onConsentChange(event.target.checked)}
          />
          <span>
            ข้าพเจ้าเลือกให้ใช้ภาพใบหน้าจากบัตรประชาชนเป็นรูปสำหรับบัตรสมาชิก
            และเข้าใจว่ารูปนี้จะถูกเก็บไว้เพื่อจัดทำบัตรสมาชิก
          </span>
        </label>
      ) : null}

      {state.photoSource === 'UPLOAD' ? (
        <ImagePicker
          label="เลือกหรือถ่ายรูปใหม่"
          hint="ใช้รูปที่มีอยู่แล้วได้ ขอให้เห็นหน้าตรง ใบหน้าชัด ฉากหลังเรียบ"
          disabled={busy}
          onSelect={onUpload}
        />
      ) : null}

      {image ? (
        <>
          <h2 className="vra-subheading">ตรวจสอบก่อนยืนยัน</h2>
          <img
            className="vra-photo-preview"
            src={image.previewUrl}
            alt="ตัวอย่างรูปสำหรับบัตรสมาชิกที่เลือกไว้"
          />
          <p className="vra-muted">ระบบจะส่งรูปเต็มตามที่แสดง โดยไม่ครอบตัดรูป</p>

          <fieldset className="vra-fieldset">
            <legend className="vra-field__label">กรุณายืนยันทุกข้อ</legend>
            <label className="vra-checkbox">
              <input
                type="checkbox"
                checked={checklist.clearFace}
                onChange={(event) => onChecklistChange({ clearFace: event.target.checked })}
              />
              <span>เห็นใบหน้าชัดเจน ไม่เบลอ ไม่มืดเกินไป</span>
            </label>
            <label className="vra-checkbox">
              <input
                type="checkbox"
                checked={checklist.noHat}
                onChange={(event) => onChecklistChange({ noHat: event.target.checked })}
              />
              <span>ไม่สวมหมวกหรือแว่นกันแดดที่ปิดใบหน้า</span>
            </label>
            <label className="vra-checkbox">
              <input
                type="checkbox"
                checked={checklist.recent}
                onChange={(event) => onChecklistChange({ recent: event.target.checked })}
              />
              <span>เป็นรูปที่ถ่ายไม่นานและเป็นรูปของข้าพเจ้าเอง</span>
            </label>
          </fieldset>
        </>
      ) : null}

      {readyForHumanCheck ? turnstileSlot : null}

      <Button onClick={onSubmit} disabled={!canSubmit} busy={busy} busyLabel="กำลังบันทึกรูป...">
        ยืนยันรูปนี้
      </Button>
    </>
  );
}
