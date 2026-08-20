import type { ApplicationRecord, PaymentRecord, ReceiptRecord, Repository } from '../db';
import { UniqueConstraintError } from '../db';
import { ApiError } from '../lib/http';
import { renderReceiptPdf } from '../lib/pdf/receipt';
import type { AuditLog } from './audit';
import { formatBaht, membershipPlan } from './membership';
import type { NumberingService } from './numbering';

/**
 * Receipt issuing (Issue #1 sections 23-27).
 *
 * A receipt is issued as soon as a payment is verified, without waiting for the
 * manager, because it attests to one thing only: the association received the
 * money. Whether the member has been registered with the NBTC is a separate
 * fact that follows later.
 *
 * The PDF is generated in memory and never stored. Only the receipt data lives
 * in D1, which is what makes regeneration exact rather than approximate.
 */

const ASSOCIATION_NAME = 'สมาคมนักวิทยุอาสาสมัคร';

const MESSAGES = {
  applicationNotFound: 'ไม่พบใบสมัครนี้',
  noPayment: 'ใบสมัครนี้ยังไม่มีการชำระเงินที่ตรวจสอบแล้ว',
  noReceipt: 'ใบสมัครนี้ยังไม่มีใบสำคัญรับเงิน',
} as const;

export interface IssuedReceipt {
  receipt: ReceiptRecord;
  /** True when this call created it, false when it already existed. */
  created: boolean;
}

export interface ReceiptService {
  /**
   * Returns the application's receipt, issuing one if it has none.
   *
   * Idempotent on purpose: the orchestration in #15 may retry after a failure
   * partway through, and a second receipt number on the same payment would put
   * two different numbers on documents the member has already seen.
   */
  issue(applicationId: string): Promise<IssuedReceipt>;
  /** Renders the PDF for an existing receipt. */
  render(applicationId: string): Promise<{ bytes: Uint8Array; filename: string }>;
  markEmailed(receiptId: string): Promise<void>;
}

/** Name for the receipt, falling back through what the record actually has. */
function payerName(application: ApplicationRecord): string {
  const thai = [application.title, application.firstName, application.lastName]
    .filter((part) => part && part.trim().length > 0)
    .join(' ')
    .trim();
  if (thai.length > 0) return thai;

  const english = [application.firstNameEn, application.lastNameEn]
    .filter((part) => part && part.trim().length > 0)
    .join(' ')
    .trim();
  return english.length > 0 ? english : 'ไม่ระบุชื่อ';
}

/** The most recent verified payment, which is the one the receipt is for. */
function verifiedPayment(payments: readonly PaymentRecord[]): PaymentRecord | null {
  const verified = payments.filter((payment) => payment.verificationStatus === 'VERIFIED');
  return verified.at(-1) ?? null;
}

/** One receipt per application and per payment; both mean the same race. */
const RECEIPT_ONCE_CONSTRAINTS = ['application_id', 'payment_id'];

export interface ReceiptServiceOptions {
  now?: () => Date;
  associationName?: string;
}

export function createReceiptService(
  db: Repository,
  numbering: NumberingService,
  audit: AuditLog,
  options: ReceiptServiceOptions = {},
): ReceiptService {
  const now = options.now ?? (() => new Date());
  const associationName = options.associationName ?? ASSOCIATION_NAME;

  const load = async (applicationId: string) => {
    const application = await db.applications.findById(applicationId);
    if (!application) {
      throw new ApiError('NOT_FOUND', MESSAGES.applicationNotFound);
    }
    const payment = verifiedPayment(await db.payments.findByApplicationId(applicationId));
    return { application, payment };
  };

  /**
   * Resolves a failed insert that was actually a lost race, or null when the
   * failure was something else and must not be swallowed.
   */
  const concurrentWinner = async (
    error: unknown,
    applicationId: string,
  ): Promise<ReceiptRecord | null> => {
    if (!(error instanceof UniqueConstraintError)) return null;
    if (!RECEIPT_ONCE_CONSTRAINTS.some((column) => error.constraintName.includes(column))) {
      return null;
    }
    return db.receipts.findByApplicationId(applicationId);
  };

  return {
    async issue(applicationId) {
      const existing = await db.receipts.findByApplicationId(applicationId);
      if (existing) {
        return { receipt: existing, created: false };
      }

      // `load` also fails a missing application, so that happens before a
      // receipt number is consumed rather than after.
      const { payment } = await load(applicationId);
      if (!payment) {
        throw new ApiError('CONFLICT', MESSAGES.noPayment);
      }

      let receipt: ReceiptRecord;
      try {
        receipt = await numbering.issueReceiptNumber((receiptNo) =>
          db.receipts.create({
            applicationId,
            paymentId: payment.id,
            receiptNo,
            // The receipt records what was actually received, which the payment
            // row already established matches the membership price.
            amountSatang: payment.amountSatang,
            issuedAt: now().toISOString(),
          }),
        );
      } catch (error) {
        // Two concurrent calls both read no receipt and both try to insert. The
        // table allows one per application, so the loser is told by the
        // database - and the right answer for it is the receipt that won, not an
        // error, because the caller asked for the application's receipt and now
        // there is one.
        const raced = await concurrentWinner(error, applicationId);
        if (!raced) throw error;
        return { receipt: raced, created: false };
      }

      await audit.record({
        applicationId,
        eventType: 'RECEIPT_ISSUED',
        actorType: 'SYSTEM',
        metadata: { receiptNo: receipt.receiptNo, amountSatang: receipt.amountSatang },
      });

      return { receipt, created: true };
    },

    async render(applicationId) {
      const receipt = await db.receipts.findByApplicationId(applicationId);
      if (!receipt) {
        throw new ApiError('NOT_FOUND', MESSAGES.noReceipt);
      }

      const { application, payment } = await load(applicationId);
      const plan = application.membershipType ? membershipPlan(application.membershipType) : null;

      const bytes = await renderReceiptPdf({
        associationName,
        receiptNo: receipt.receiptNo,
        issuedAt: new Date(receipt.issuedAt),
        payerName: payerName(application),
        // A receipt issued before the application number exists would be odd,
        // but printing an empty box would be worse than saying so.
        applicationReferenceNo: application.referenceNo ?? 'ยังไม่ออกเลขที่ใบสมัคร',
        membershipLabel: plan?.labelTh ?? 'ไม่ระบุประเภทสมาชิก',
        amountBaht: formatBaht(receipt.amountSatang),
        transactionRef: payment?.transactionRef ?? 'ไม่ระบุ',
        paidAt: payment?.transactionAt ? new Date(payment.transactionAt) : null,
        bankName: payment?.receivingBank ?? null,
      });

      return { bytes, filename: `${receipt.receiptNo}.pdf` };
    },

    async markEmailed(receiptId) {
      await db.receipts.markEmailSent(receiptId, now().toISOString());
    },
  };
}
