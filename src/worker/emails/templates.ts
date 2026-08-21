import { ASSOCIATION_NAME, NBTC_PUBLIC_SERVICE_URL } from '../lib/association';
import { renderEmail } from './layout';
import type { DetailRow, EmailBlock, RenderedEmail } from './layout';

/**
 * The four transactional emails (Issue #1 section 55).
 *
 * Each template is a pure function of the data it is given: the caller resolves
 * every value from the database and passes it in. Nothing here reads a record,
 * a clock or a configuration value, which is what makes the templates testable
 * with synthetic data and keeps a retry from rendering something different from
 * the first attempt.
 */

/* ----------------------------------------------------- shared fragments ---- */

const NEXT_STEP_LINES = [
  'ผู้จัดการสมาคมจะตรวจสอบใบสมัครและดำเนินการบันทึกข้อมูลทะเบียนสมาชิกในระบบของสำนักงาน กสทช.',
  'เมื่อดำเนินการเรียบร้อยแล้ว ระบบจะแจ้งผลให้ท่านทราบทางอีเมลอีกครั้ง',
];

/**
 * The full name as it should be addressed, falling back through what is known.
 * An empty greeting reads worse than a neutral one.
 */
export function displayName(parts: {
  title?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  const name = [parts.title, parts.firstName, parts.lastName]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .join(' ');
  return name.length > 0 ? name : 'ท่านสมาชิก';
}

/**
 * Shows only the last four digits of a citizen ID.
 *
 * The manager needs enough to match a person against their own records; the
 * full number they need for the NBTC system is on the application detail page,
 * where reading it is authenticated and audited. Mailing the whole number would
 * put it in Resend's records and in a mailbox permanently, which is precisely
 * what encrypting it in the database is meant to prevent. See
 * `docs/decisions/0002-citizen-id-not-in-email.md`.
 */
export function maskCitizenId(citizenId: string): string {
  const digits = citizenId.replace(/\D/g, '');
  if (digits.length < 4) return 'x-xxxx-xxxxx-xx-x';
  // Printed as `x-xxxx-xxxxx-xx-x`, so the four visible digits have to land in
  // the groups they occupy on the card: one at the end of the five, two in the
  // pair, and the check digit.
  const last = digits.slice(-4);
  return `x-xxxx-xxxx${last[0]}-${last[1]}${last[2]}-${last[3]}`;
}

function presentRows(rows: readonly (DetailRow | null)[]): DetailRow[] {
  return rows.filter((row): row is DetailRow => row !== null);
}

/** Drops a row rather than printing an empty value next to a label. */
function row(label: string, value: string | null | undefined): DetailRow | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? { label, value: trimmed } : null;
}

/* --------------------------------------------- 1. receipt, to the member ---- */

export interface ReceiptEmailData {
  recipientName: string;
  applicationReferenceNo: string;
  membershipLabel: string;
  amountBaht: string;
  receiptNo: string;
  paidAtLabel: string | null;
}

export function receiptEmail(data: ReceiptEmailData): RenderedEmail {
  const blocks: EmailBlock[] = [
    {
      kind: 'paragraph',
      text: `เรียน ${data.recipientName}`,
    },
    {
      kind: 'paragraph',
      text: `${ASSOCIATION_NAME} ได้รับใบสมัครและค่าบำรุงสมาชิกของท่านเรียบร้อยแล้ว ใบสำคัญรับเงินแนบมากับอีเมลนี้`,
    },
    {
      kind: 'details',
      rows: presentRows([
        row('เลขที่ใบสมัคร', data.applicationReferenceNo),
        row('ประเภทสมาชิก', data.membershipLabel),
        row('ยอดเงิน', `${data.amountBaht} บาท`),
        row('สถานะการชำระเงิน', 'ตรวจสอบแล้ว ได้รับเงินเรียบร้อย'),
        row('เลขที่ใบสำคัญรับเงิน', data.receiptNo),
        row('วันและเวลาที่ชำระเงิน', data.paidAtLabel),
      ]),
    },
    { kind: 'paragraph', text: 'ขั้นตอนต่อไป' },
    { kind: 'lines', lines: NEXT_STEP_LINES },
    {
      kind: 'note',
      // The same distinction the receipt itself makes. A member who reads this
      // as "I am registered" would stop waiting for the email that says so.
      text: 'ใบสำคัญรับเงินเป็นหลักฐานการรับเงิน ไม่ใช่หลักฐานการบันทึกทะเบียนสมาชิกกับสำนักงาน กสทช.',
    },
  ];

  return renderEmail({
    subject: `${ASSOCIATION_NAME}ได้รับใบสมัครและค่าบำรุงสมาชิกแล้ว — ${data.applicationReferenceNo}`,
    preheader: `ใบสำคัญรับเงินเลขที่ ${data.receiptNo} แนบมากับอีเมลนี้`,
    heading: 'ได้รับใบสมัครและค่าบำรุงสมาชิกแล้ว',
    blocks,
  });
}

/* ------------------------------------ 2. new application, to the manager ---- */

export interface ManagerNewApplicationEmailData {
  applicantName: string;
  applicantNameEn: string | null;
  applicationReferenceNo: string;
  membershipLabel: string;
  /** Masked before it reaches this function; the full number is never passed. */
  maskedCitizenId: string;
  birthDateLabel: string | null;
  idAddress: string | null;
  email: string | null;
  phone: string | null;
  callsign: string | null;
  amountBaht: string | null;
  transactionRef: string | null;
  paidAtLabel: string | null;
  detailUrl: string;
  acknowledgeUrl: string;
  nbtcCompleteUrl: string;
}

export function managerNewApplicationEmail(data: ManagerNewApplicationEmailData): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: 'emphasis', label: 'เลขที่ใบสมัคร', value: data.applicationReferenceNo },
    {
      kind: 'details',
      rows: presentRows([
        row('ชื่อ-นามสกุล', data.applicantName),
        row('ชื่อภาษาอังกฤษ', data.applicantNameEn),
        row('เลขบัตรประชาชน', data.maskedCitizenId),
        row('วันเกิด', data.birthDateLabel),
        row('ที่อยู่ตามบัตร', data.idAddress),
        row('อีเมล', data.email),
        row('โทรศัพท์', data.phone),
        row('สัญญาณเรียกขาน', data.callsign),
      ]),
    },
    {
      kind: 'details',
      rows: presentRows([
        row('ประเภทสมาชิก', data.membershipLabel),
        row('สถานะการชำระเงิน', data.transactionRef ? 'ตรวจสอบแล้ว ได้รับเงินเรียบร้อย' : null),
        row('ยอดเงิน', data.amountBaht ? `${data.amountBaht} บาท` : null),
        row('อ้างอิงรายการโอน', data.transactionRef),
        row('วันและเวลาที่ชำระเงิน', data.paidAtLabel),
      ]),
    },
    {
      kind: 'note',
      // Explains the masking rather than leaving the manager to wonder whether
      // the system failed to read the card.
      text: 'เลขบัตรประชาชนแสดงเพียงบางส่วนในอีเมล เลขเต็มดูได้ในหน้ารายละเอียดใบสมัครซึ่งบันทึกการเข้าถึงไว้',
    },
    { kind: 'button', href: data.detailUrl, label: 'เปิดรายละเอียดใบสมัคร' },
    { kind: 'button', href: data.acknowledgeUrl, label: 'รับเรื่อง / เริ่มดำเนินการ' },
    { kind: 'button', href: data.nbtcCompleteUrl, label: 'บันทึกในระบบ กสทช. เรียบร้อยแล้ว' },
    {
      kind: 'note',
      // Both links land on a confirmation page; nothing changes from following
      // them, which is what makes them safe for a scanner to open
      // (Issue #1 section 37).
      text: 'ปุ่มทั้งสามพาไปยังหน้ายืนยันในระบบผู้จัดการ การเปลี่ยนสถานะเกิดขึ้นเมื่อกดยืนยันในหน้านั้นเท่านั้น',
    },
    {
      kind: 'note',
      text: 'อีเมลนี้ไม่แนบรูปบัตรประชาชน รูปสลิป หรือรูปสมาชิก เอกสารทั้งหมดดูได้ในระบบผู้จัดการ',
    },
  ];

  return renderEmail({
    subject: `[ใบสมัครสมาชิกใหม่] ${data.applicationReferenceNo} — ${data.applicantName}`,
    preheader: `${data.membershipLabel} — ชำระเงินแล้ว รอบันทึกทะเบียน กสทช.`,
    heading: 'ใบสมัครสมาชิกใหม่ รอดำเนินการ',
    blocks,
  });
}

/* --------------------------------------- 3. processing, to the member ------- */

export interface MemberProcessingEmailData {
  recipientName: string;
  applicationReferenceNo: string;
}

export function memberProcessingEmail(data: MemberProcessingEmailData): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: `เรียน ${data.recipientName}` },
    { kind: 'paragraph', text: `${ASSOCIATION_NAME} ได้รับเรื่องของท่านแล้ว` },
    {
      kind: 'details',
      rows: [
        { label: 'เลขที่ใบสมัคร', value: data.applicationReferenceNo },
        { label: 'สถานะปัจจุบัน', value: 'อยู่ระหว่างการดำเนินการของผู้จัดการสมาคม' },
      ],
    },
    { kind: 'lines', lines: NEXT_STEP_LINES },
  ];

  return renderEmail({
    subject: `สมาคมได้รับเรื่องและอยู่ระหว่างดำเนินการ — ${data.applicationReferenceNo}`,
    preheader: 'ผู้จัดการสมาคมกำลังดำเนินการบันทึกทะเบียนสมาชิกกับสำนักงาน กสทช.',
    heading: 'อยู่ระหว่างดำเนินการ',
    blocks,
  });
}

/* ------------------------------------- 4. NBTC completed, to the member ----- */

export interface MemberCompletedEmailData {
  recipientName: string;
  applicationReferenceNo: string;
  membershipLabel: string;
  recordedAtLabel: string | null;
}

export function memberCompletedEmail(data: MemberCompletedEmailData): RenderedEmail {
  const blocks: EmailBlock[] = [
    { kind: 'paragraph', text: `เรียน ${data.recipientName}` },
    {
      kind: 'paragraph',
      text: `${ASSOCIATION_NAME} ได้ดำเนินการบันทึกข้อมูลทะเบียนสมาชิกของท่านในระบบของสำนักงาน กสทช. เรียบร้อยแล้ว`,
    },
    {
      kind: 'details',
      rows: presentRows([
        row('เลขที่ใบสมัคร', data.applicationReferenceNo),
        row('ประเภทสมาชิก', data.membershipLabel),
        row('วันที่บันทึกทะเบียน', data.recordedAtLabel),
      ]),
    },
    {
      kind: 'button',
      href: NBTC_PUBLIC_SERVICE_URL,
      label: 'ตรวจสอบข้อมูลกับสำนักงาน กสทช.',
    },
    {
      kind: 'note',
      text: 'ข้อมูลในระบบของสำนักงาน กสทช. อาจใช้เวลาปรับปรุงสักครู่หลังการบันทึก',
    },
  ];

  return renderEmail({
    subject: `บันทึกข้อมูลสมาชิกเรียบร้อยแล้ว — ${ASSOCIATION_NAME}`,
    preheader: `ใบสมัครเลขที่ ${data.applicationReferenceNo} ดำเนินการครบถ้วนแล้ว`,
    heading: 'บันทึกข้อมูลสมาชิกเรียบร้อยแล้ว',
    blocks,
  });
}
