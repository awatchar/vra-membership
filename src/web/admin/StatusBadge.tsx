import type { ApplicationStatus } from './api';

/**
 * The application status, in Thai.
 *
 * A word as well as a colour. A colour-only badge is unreadable to a screen
 * reader and ambiguous to anyone who cannot distinguish the two greens - and
 * these statuses are the thing the manager scans the queue by.
 */

const LABELS: Readonly<Record<ApplicationStatus, string>> = {
  DRAFT: 'ยังไม่ชำระเงิน',
  AWAITING_PAYMENT: 'รอชำระเงิน',
  PAYMENT_VERIFIED: 'ตรวจสอบการชำระเงินแล้ว',
  SUBMITTED: 'ส่งใบสมัครแล้ว',
  MANAGER_NOTIFIED: 'รอผู้จัดการรับเรื่อง',
  NBTC_PROCESSING: 'อยู่ระหว่างบันทึกทะเบียน',
  NBTC_RECORDED: 'บันทึกทะเบียนแล้ว',
  COMPLETED: 'เสร็จสมบูรณ์',
  REJECTED: 'ปฏิเสธใบสมัคร',
  CANCELLED: 'ยกเลิกใบสมัคร',
  REFUND_REQUIRED: 'ต้องคืนเงิน',
  REFUNDED: 'คืนเงินแล้ว',
};

/** Grouped by what the manager should do about it, not by position in the flow. */
const TONES: Readonly<Record<ApplicationStatus, string>> = {
  DRAFT: 'idle',
  AWAITING_PAYMENT: 'idle',
  PAYMENT_VERIFIED: 'busy',
  SUBMITTED: 'busy',
  MANAGER_NOTIFIED: 'action',
  NBTC_PROCESSING: 'action',
  NBTC_RECORDED: 'busy',
  COMPLETED: 'done',
  REJECTED: 'stop',
  CANCELLED: 'idle',
  REFUND_REQUIRED: 'stop',
  REFUNDED: 'done',
};

function statusLabel(status: ApplicationStatus): string {
  return LABELS[status] ?? status;
}

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  return (
    <span className={`vra-badge vra-badge--${TONES[status] ?? 'idle'}`}>{statusLabel(status)}</span>
  );
}
