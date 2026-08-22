import type { ManualPaymentReview } from '../api/types';
import { Alert } from '../components/Alert';
import { Button } from '../components/Button';

export interface PaymentReviewStepProps {
  review: ManualPaymentReview;
  onRetryAutomatic: () => void;
}

export function PaymentReviewStep({ review, onRetryAutomatic }: PaymentReviewStepProps) {
  return (
    <>
      <Alert tone="success" title="ส่งคำขอตรวจสอบให้เจ้าหน้าที่แล้ว">
        <p>{review.message}</p>
      </Alert>

      <h2 className="vra-subheading">สิ่งที่จะเกิดขึ้นต่อไป</h2>
      <ul>
        <li>เจ้าหน้าที่ตรวจยอดและเลขอ้างอิงจากรายการเดินบัญชีของสมาคม</li>
        <li>รูปสลิปถูกทิ้งแล้ว ไม่ถูกเก็บในระบบหรือส่งไปทางอีเมล</li>
        <li>ระบบจะออกใบสำคัญรับเงินและส่งใบสมัครต่อเมื่อเจ้าหน้าที่ยืนยันรายการจริงเท่านั้น</li>
      </ul>

      {!review.notificationSent ? (
        <Alert tone="info">
          <p>คำขอถูกบันทึกและมองเห็นในระบบผู้จัดการแล้ว แม้อีเมลแจ้งเตือนจะยังส่งไม่สำเร็จ</p>
        </Alert>
      ) : null}

      <p className="vra-muted">
        หากมีภาพสลิปที่ชัดกว่า ท่านยังสามารถลองตรวจสอบอัตโนมัติอีกครั้งได้
      </p>
      <Button variant="secondary" onClick={onRetryAutomatic}>
        แนบสลิปที่ชัดกว่า
      </Button>
    </>
  );
}
