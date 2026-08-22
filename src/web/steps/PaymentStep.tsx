import { Alert } from '../components/Alert';
import { Button } from '../components/Button';
import { ImagePicker } from '../components/ImagePicker';
import { QrCode } from '../components/QrCode';
import type { PaymentInstructions } from '../api/types';

/**
 * Transferring the fee and submitting the slip (Issue #1 sections 15-18).
 *
 * The QR carries the exact amount, which is the point of it: the single most
 * common cause of a payment that has to be refunded by hand is the wrong total
 * typed into a banking app. The account number is shown too, because a QR is
 * useless to someone paying from a desktop or over the counter.
 *
 * Slip handling is stated plainly to the applicant rather than only implemented:
 * the browser reads the QR and sends the reference, and the image only leaves the
 * device if the code will not read. People are reasonably wary of uploading a
 * bank slip, and this is the difference between a wary applicant and an abandoned
 * application.
 */

export interface PaymentStepProps {
  instructions: PaymentInstructions;
  busy: boolean;
  /** Set while the browser is decoding, before anything is sent. */
  reading: boolean;
  error: string | null;
  /** Null until a QR has been read, which is what enables the submit. */
  qrPayload: string | null;
  usedImageFallback: boolean;
  onSlipSelected: (file: File) => void;
  onSubmit: () => void;
  turnstileSlot: React.ReactNode;
}

export function PaymentStep({
  instructions,
  busy,
  reading,
  error,
  qrPayload,
  usedImageFallback,
  onSlipSelected,
  onSubmit,
  turnstileSlot,
}: PaymentStepProps) {
  return (
    <>
      <div className="vra-amount">
        <p className="vra-amount__label">{instructions.membershipLabel}</p>
        <p className="vra-amount__value">{instructions.amountBaht} บาท</p>
      </div>

      {instructions.qrPayload ? (
        <div className="vra-qr-wrap">
          <QrCode
            payload={instructions.qrPayload}
            label={`QR สำหรับโอนเงิน ${instructions.amountBaht} บาท ไปยังบัญชีของสมาคม`}
          />
          <p className="vra-muted">
            สแกน QR นี้ด้วยแอปธนาคาร ยอดเงินถูกกำหนดไว้แล้วจึงไม่ต้องพิมพ์เอง
          </p>
        </div>
      ) : null}

      <dl className="vra-details">
        <div className="vra-details__row">
          <dt>ธนาคาร</dt>
          <dd>{instructions.bankName}</dd>
        </div>
        <div className="vra-details__row">
          <dt>ชื่อบัญชี</dt>
          <dd>{instructions.accountName}</dd>
        </div>
        <div className="vra-details__row">
          <dt>เลขที่บัญชี</dt>
          <dd>{instructions.accountNumber}</dd>
        </div>
        <div className="vra-details__row">
          <dt>ยอดที่ต้องโอน</dt>
          <dd>{instructions.amountBaht} บาท</dd>
        </div>
      </dl>

      <hr className="vra-divider" />

      <h2 className="vra-subheading">เมื่อโอนเงินแล้ว</h2>
      <p className="vra-muted">
        เลือกภาพสลิปการโอน เบราว์เซอร์จะอ่าน QR บนสลิปและส่งเฉพาะข้อมูลอ้างอิง
        ภาพสลิปจะไม่ออกจากเครื่องของท่าน หากอ่าน QR ไม่ได้ ระบบจะขอส่งภาพสลิปแทน
      </p>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <ImagePicker
        label="เลือกภาพสลิปการโอนเงิน"
        hint="ใช้ภาพหน้าจอ (screenshot) จากแอปธนาคารได้เลย ไม่ต้องถ่ายใหม่"
        disabled={busy || reading}
        onSelect={onSlipSelected}
      />

      {reading ? (
        <Alert tone="info">
          <p>กำลังอ่าน QR บนสลิป...</p>
        </Alert>
      ) : null}

      {qrPayload ? (
        <Alert tone="success" title="อ่าน QR บนสลิปได้แล้ว">
          <p>ระบบจะส่งเฉพาะข้อมูลอ้างอิงจาก QR ภาพสลิปไม่ถูกส่งออกไป</p>
        </Alert>
      ) : null}

      {usedImageFallback ? (
        <Alert tone="info" title="อ่าน QR บนสลิปไม่ได้">
          <p>
            ระบบจะส่งภาพสลิปเพื่อตรวจสอบแทน ถ้าระบบอัตโนมัติยังอ่านไม่ได้
            เจ้าหน้าที่จะตรวจรายการเดินบัญชีของสมาคมให้ ภาพใช้ตรวจรายการเท่านั้นและไม่ถูกเก็บไว้
          </p>
        </Alert>
      ) : null}

      {turnstileSlot}

      <Button
        onClick={onSubmit}
        disabled={!qrPayload && !usedImageFallback}
        busy={busy}
        busyLabel="กำลังตรวจสอบการชำระเงิน..."
      >
        ส่งหลักฐานการชำระเงิน
      </Button>
    </>
  );
}
