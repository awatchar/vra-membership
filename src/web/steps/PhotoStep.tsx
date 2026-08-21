import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { CropBox } from '../components/CropBox';
import { ImagePicker } from '../components/ImagePicker';
import type { CropRegion } from '../lib/image';
import type { HeldImage, WizardState } from '../state/wizard';

/**
 * Choosing the member photo (Issue #1 sections 11, 12 and 61).
 *
 * The card's face image is offered, never assumed. Selecting it reveals a
 * separate consent checkbox, and the submit button stays disabled until that box
 * is ticked - section 61 forbids using the face from the card without the
 * applicant knowing. Switching to an upload clears the consent, so it can never
 * apply to a choice that was undone.
 *
 * The three-item checklist is the section 12 confirmation. It is three boxes
 * rather than one because "I confirm this photo is suitable" is a box people tick
 * without reading; "the face is clear", "no hat or sunglasses" and "taken
 * recently" are three specific things to actually look at.
 */

export interface PhotoStepProps {
  state: WizardState;
  region: CropRegion;
  busy: boolean;
  error: string | null;
  canSubmit: boolean;
  onChooseSource: (source: 'ID_CARD' | 'UPLOAD') => void;
  onConsentChange: (accepted: boolean) => void;
  onUpload: (file: File) => void;
  onRegionChange: (region: CropRegion) => void;
  onChecklistChange: (values: Partial<WizardState['photoChecklist']>) => void;
  onSubmit: () => void;
}

/** The image the crop control is working on, whichever source was chosen. */
function sourceImage(state: WizardState): HeldImage | null {
  return state.photoSource === 'ID_CARD' ? state.faceImage : state.uploadedPhoto;
}

export function PhotoStep({
  state,
  region,
  busy,
  error,
  canSubmit,
  onChooseSource,
  onConsentChange,
  onUpload,
  onRegionChange,
  onChecklistChange,
  onSubmit,
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
          <h2 className="vra-subheading">ปรับกรอบรูป</h2>
          <p className="vra-muted">
            รูปบัตรสมาชิกเป็นสี่เหลี่ยมจัตุรัส เลื่อนกรอบให้ใบหน้าอยู่กลางภาพ
          </p>
          <CropBox imageUrl={image.previewUrl} region={region} onChange={onRegionChange} />
        </>
      ) : null}

      {state.croppedPhoto ? (
        <>
          <h2 className="vra-subheading">ตรวจสอบก่อนยืนยัน</h2>
          <img
            className="vra-photo-preview"
            src={state.croppedPhoto.previewUrl}
            alt="ตัวอย่างรูปสำหรับบัตรสมาชิกที่เลือกไว้"
          />

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

      <Button onClick={onSubmit} disabled={!canSubmit} busy={busy} busyLabel="กำลังบันทึกรูป...">
        ยืนยันรูปนี้
      </Button>
    </>
  );
}
