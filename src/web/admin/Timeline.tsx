import { formatDateTime } from '../lib/datetime';
import type { AdminEvent } from './api';

/**
 * The audit trail for one application (Issue #1 sections 49-50).
 *
 * Event types are translated because the trail is something the manager reads
 * when a member phones to ask what happened, not a debugging log. An untranslated
 * `MEMBER_PROCESSING_EMAIL_SENT` is answerable only by someone who wrote the
 * system.
 *
 * Anything not in the table below is shown as-is rather than hidden. A trail that
 * silently drops what it does not recognise is worse than one with an odd row in
 * it: the manager would have no way to know something happened.
 */

const EVENT_LABELS: Readonly<Record<string, string>> = {
  APPLICATION_CREATED: 'สร้างใบสมัคร',
  ID_OCR_COMPLETED: 'อ่านข้อมูลจากบัตรประชาชน',
  PHOTO_SELECTED: 'เลือกรูปสำหรับบัตรสมาชิก',
  PHOTO_REPLACED: 'เปลี่ยนรูปสำหรับบัตรสมาชิก',
  STATUS_CHANGED: 'เปลี่ยนสถานะ',
  PAYMENT_VERIFIED: 'ตรวจสอบการชำระเงินผ่าน',
  PAYMENT_REJECTED: 'การชำระเงินไม่ผ่านการตรวจสอบ',
  PAYMENT_MANUAL_REVIEW_REQUESTED: 'ส่งคำขอตรวจสอบการชำระเงินโดยเจ้าหน้าที่',
  PAYMENT_MANUAL_REVIEW_APPROVED: 'เจ้าหน้าที่ยืนยันรายการชำระเงิน',
  PAYMENT_PRESENTED_WHEN_NOT_EXPECTED: 'ส่งหลักฐานการชำระเงินซ้ำ',
  RECEIPT_ISSUED: 'ออกใบสำคัญรับเงิน',
  RECEIPT_EMAIL_SENT: 'ส่งใบสำคัญรับเงินทางอีเมล',
  RECEIPT_DOWNLOADED: 'ดาวน์โหลดใบสำคัญรับเงิน',
  APPLICATION_SUBMITTED: 'ส่งใบสมัครเข้าระบบ',
  MANAGER_EMAIL_SENT: 'แจ้งผู้จัดการทางอีเมล',
  MANAGER_PAYMENT_REVIEW_EMAIL_SENT: 'แจ้งคำขอตรวจการชำระเงินทางอีเมล',
  MANAGER_EMAIL_OPENED: 'ผู้จัดการเปิดอีเมล',
  MANAGER_ACKNOWLEDGED: 'ผู้จัดการรับเรื่อง',
  MEMBER_PROCESSING_EMAIL_SENT: 'แจ้งสมาชิกว่าอยู่ระหว่างดำเนินการ',
  MANAGER_CONFIRMED_NBTC_RECORD: 'ผู้จัดการยืนยันการบันทึกทะเบียน กสทช.',
  MEMBER_COMPLETION_EMAIL_SENT: 'แจ้งสมาชิกว่าบันทึกทะเบียนเรียบร้อย',
  CITIZEN_ID_ACCESSED: 'มีการเปิดดูเลขบัตรประชาชน',
  CITIZEN_ID_MASKED_FOR_EMAIL: 'ใช้เลขบัตรประชาชนบางส่วนในอีเมลผู้จัดการ',
  EMAIL_SEND_FAILED: 'ส่งอีเมลไม่สำเร็จ',
  EMAIL_SKIPPED: 'ไม่ได้ส่งอีเมล',
  EMAIL_BOUNCED: 'อีเมลตีกลับ',
};

const ACTOR_LABELS: Readonly<Record<string, string>> = {
  APPLICANT: 'ผู้สมัคร',
  MANAGER: 'ผู้จัดการ',
  SYSTEM: 'ระบบ',
  PROVIDER: 'ผู้ให้บริการ',
};

/** Metadata keys the manager can act on; the rest is machinery. */
const METADATA_LABELS: Readonly<Record<string, string>> = {
  from: 'จาก',
  to: 'เป็น',
  reason: 'เหตุผล',
  emailType: 'ชนิดอีเมล',
  receiptNo: 'เลขที่ใบสำคัญรับเงิน',
  referenceNo: 'เลขที่ใบสมัคร',
  amountSatang: 'ยอด (สตางค์)',
  provider: 'ผู้ให้บริการ',
  source: 'ที่มา',
};

function describe(event: AdminEvent): string | null {
  if (!event.metadata) return null;
  const parts = Object.entries(event.metadata)
    .filter(([key]) => key in METADATA_LABELS)
    .map(([key, value]) => `${METADATA_LABELS[key]!}: ${String(value)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function Timeline({ events }: { events: readonly AdminEvent[] }) {
  if (events.length === 0) {
    return <p className="vra-muted">ยังไม่มีเหตุการณ์</p>;
  }

  return (
    <ol className="vra-timeline">
      {events.map((event) => {
        const detail = describe(event);
        return (
          <li className="vra-timeline__item" key={event.id}>
            <p className="vra-timeline__when">{formatDateTime(event.createdAt)}</p>
            <p className="vra-timeline__what">{EVENT_LABELS[event.eventType] ?? event.eventType}</p>
            <p className="vra-timeline__who">
              {ACTOR_LABELS[event.actorType] ?? event.actorType}
              {event.actorId ? ` · ${event.actorId}` : ''}
            </p>
            {detail ? <p className="vra-timeline__meta">{detail}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
