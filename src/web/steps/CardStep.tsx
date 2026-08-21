import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { ImagePicker } from '../components/ImagePicker';

/**
 * Reading the front of the ID card.
 *
 * The manual-entry escape hatch is offered from the start, not only after a
 * failure. OCR on a phone photo of a worn card fails often enough that hiding
 * the alternative until it does would leave some applicants stuck on the second
 * step of the form, and a Thai ID card is not a document people are willing to
 * photograph five times.
 */

export interface CardStepProps {
  busy: boolean;
  error: string | null;
  onSelect: (file: File) => void;
  onManualEntry: () => void;
  turnstileSlot: React.ReactNode;
}

export function CardStep({ busy, error, onSelect, onManualEntry, turnstileSlot }: CardStepProps) {
  return (
    <>
      {error ? (
        <Alert tone="error" title="อ่านข้อมูลจากบัตรไม่สำเร็จ">
          <p>{error}</p>
          <p>ลองถ่ายใหม่ให้เห็นบัตรทั้งใบในที่ที่มีแสงพอ หรือกรอกข้อมูลเองก็ได้</p>
        </Alert>
      ) : null}

      <p className="vra-muted">
        ใช้ภาพที่มีอยู่แล้วในเครื่องก็ได้ หรือถ่ายใหม่ก็ได้ — เมื่อกดเลือกไฟล์
        เครื่องของท่านจะให้เลือกได้ทั้งกล้อง อัลบั้ม และไฟล์
      </p>

      <ol className="vra-tips">
        <li>ถ้าถ่ายใหม่ วางบัตรบนพื้นเรียบสีเข้ม ถ่ายจากด้านบนตรง ๆ</li>
        <li>ให้เห็นบัตรทั้งใบ ไม่มีนิ้วบังตัวเลข</li>
        <li>หลีกเลี่ยงแสงสะท้อนบนบัตร</li>
      </ol>

      <ImagePicker
        label="เลือกหรือถ่ายภาพด้านหน้าบัตรประชาชน"
        hint="ระบบใช้ภาพนี้เพื่ออ่านข้อมูลเท่านั้น และไม่เก็บภาพบัตรไว้"
        disabled={busy}
        onSelect={onSelect}
      />

      {turnstileSlot}

      {busy ? (
        <Alert tone="info">
          <p>กำลังอ่านข้อมูลจากบัตร อาจใช้เวลาสักครู่ กรุณาอย่าปิดหน้านี้</p>
        </Alert>
      ) : null}

      <hr className="vra-divider" />

      <p className="vra-muted">ถ่ายภาพไม่สะดวก หรืออ่านข้อมูลไม่ผ่าน?</p>
      <Button variant="secondary" onClick={onManualEntry} disabled={busy}>
        กรอกข้อมูลเองแทน
      </Button>
    </>
  );
}
