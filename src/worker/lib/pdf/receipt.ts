import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import { formatThaiDate, formatThaiDateTime } from '../time';
import { embedThaiFonts } from './fonts';
import type { ThaiFonts } from './fonts';

/**
 * Receipt PDF (Issue #1 sections 23-26).
 *
 * Generated in memory from the receipt record and never stored. The record in
 * D1 is the durable artefact, so the same document can be produced again at any
 * time - which is what makes "regenerate" a real feature rather than a
 * best-effort reconstruction.
 *
 * The receipt confirms that the association **received money**. It deliberately
 * does not say anything about NBTC registration, because those are different
 * facts and conflating them would mislead the member about where their
 * application stands.
 */

/** A4 in PDF points. */
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 56;

const INK = rgb(0.08, 0.12, 0.17);
const MUTED = rgb(0.35, 0.4, 0.46);
const RULE = rgb(0.78, 0.82, 0.86);

export interface ReceiptDocumentData {
  associationName: string;
  receiptNo: string;
  issuedAt: Date;
  /** Full name as it should appear on the receipt. */
  payerName: string;
  applicationReferenceNo: string;
  membershipLabel: string;
  amountBaht: string;
  transactionRef: string;
  paidAt: Date | null;
  bankName: string | null;
}

interface Cursor {
  y: number;
}

function drawHeading(page: PDFPage, fonts: ThaiFonts, cursor: Cursor, data: ReceiptDocumentData) {
  page.drawText(data.associationName, {
    font: fonts.bold,
    size: 18,
    x: MARGIN,
    y: cursor.y,
    color: INK,
  });
  cursor.y -= 26;

  page.drawText('ใบสำคัญรับเงิน', {
    font: fonts.bold,
    size: 24,
    x: MARGIN,
    y: cursor.y,
    color: INK,
  });
  cursor.y -= 14;

  page.drawLine({
    start: { x: MARGIN, y: cursor.y },
    end: { x: PAGE_WIDTH - MARGIN, y: cursor.y },
    thickness: 1,
    color: RULE,
  });
  cursor.y -= 28;
}

function drawRow(
  page: PDFPage,
  fonts: ThaiFonts,
  cursor: Cursor,
  label: string,
  value: string,
  options: { emphasis?: boolean } = {},
) {
  const labelX = MARGIN;
  const valueX = MARGIN + 190;

  page.drawText(label, { font: fonts.regular, size: 11, x: labelX, y: cursor.y, color: MUTED });
  page.drawText(value, {
    font: options.emphasis ? fonts.bold : fonts.regular,
    size: options.emphasis ? 14 : 12,
    x: valueX,
    y: cursor.y - (options.emphasis ? 2 : 0),
    color: INK,
  });

  cursor.y -= options.emphasis ? 30 : 24;
}

/**
 * Builds the receipt PDF and returns its bytes.
 *
 * Every value comes from the caller rather than being read here, so the same
 * function serves the first issue and any later regeneration without a second
 * code path that could drift.
 */
export async function renderReceiptPdf(data: ReceiptDocumentData): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.setTitle(`ใบสำคัญรับเงิน ${data.receiptNo}`);
  // No author or producer metadata: those fields would carry the applicant's
  // details or ours into a file that leaves the system.
  document.setCreationDate(data.issuedAt);
  document.setModificationDate(data.issuedAt);

  const fonts = await embedThaiFonts(document);
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const cursor: Cursor = { y: PAGE_HEIGHT - MARGIN };

  drawHeading(page, fonts, cursor, data);

  drawRow(page, fonts, cursor, 'เลขที่ใบสำคัญรับเงิน', data.receiptNo, { emphasis: true });
  drawRow(page, fonts, cursor, 'วันที่ออกใบสำคัญรับเงิน', formatThaiDate(data.issuedAt));
  cursor.y -= 8;

  drawRow(page, fonts, cursor, 'ได้รับเงินจาก', data.payerName);
  drawRow(page, fonts, cursor, 'เลขที่ใบสมัคร', data.applicationReferenceNo);
  drawRow(page, fonts, cursor, 'ประเภทสมาชิก', data.membershipLabel);
  drawRow(page, fonts, cursor, 'ค่าบำรุงสมาชิก', `${data.amountBaht} บาท`, { emphasis: true });
  cursor.y -= 8;

  drawRow(page, fonts, cursor, 'อ้างอิงรายการโอน', data.transactionRef);
  drawRow(
    page,
    fonts,
    cursor,
    'วันและเวลาที่ชำระเงิน',
    data.paidAt ? formatThaiDateTime(data.paidAt) : 'ไม่ระบุ',
  );
  if (data.bankName) {
    drawRow(page, fonts, cursor, 'ธนาคารผู้รับเงิน', data.bankName);
  }

  cursor.y -= 12;
  page.drawLine({
    start: { x: MARGIN, y: cursor.y },
    end: { x: PAGE_WIDTH - MARGIN, y: cursor.y },
    thickness: 1,
    color: RULE,
  });
  cursor.y -= 28;

  page.drawText('สมาคมได้รับเงินค่าบำรุงสมาชิกตามรายการข้างต้นเรียบร้อยแล้ว', {
    font: fonts.bold,
    size: 13,
    x: MARGIN,
    y: cursor.y,
    color: INK,
  });
  cursor.y -= 22;

  // Stated explicitly because the two are easy to confuse, and a member who
  // reads this as "I am registered" would stop waiting for the email that says
  // they actually are.
  page.drawText(
    'เอกสารนี้เป็นหลักฐานการรับเงิน ไม่ใช่หลักฐานการบันทึกทะเบียนสมาชิกกับสำนักงาน กสทช.',
    { font: fonts.regular, size: 10.5, x: MARGIN, y: cursor.y, color: MUTED },
  );
  cursor.y -= 16;
  page.drawText('สมาคมจะแจ้งผลการบันทึกทะเบียนให้ทราบทางอีเมลอีกครั้ง', {
    font: fonts.regular,
    size: 10.5,
    x: MARGIN,
    y: cursor.y,
    color: MUTED,
  });

  page.drawText('เอกสารนี้ออกโดยระบบอัตโนมัติ', {
    font: fonts.regular,
    size: 9,
    x: MARGIN,
    y: MARGIN,
    color: MUTED,
  });

  return document.save();
}
