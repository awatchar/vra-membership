import { UniqueConstraintError } from '../db';
import type { PaymentRecord, Repository } from '../db';
import { ApiError } from '../lib/http';
import type { SlipEvidence, SlipVerificationProvider } from '../providers';
import type { AuditLog } from './audit';
import { membershipPlan } from './membership';
import type { StateMachine } from './state-machine';

/**
 * Payment verification (Issue #1 sections 17-22).
 *
 * Five things have to be true before the association accepts that it was paid,
 * and each is checked here rather than being taken on trust from the provider:
 *
 * 1. the transaction exists in the bank's records
 * 2. the money went to the association's account
 * 3. the amount matches the membership type, resolved on the server
 * 4. the slip has not been used before
 * 5. the transfer happened recently enough to belong to this application
 *
 * Every one of them is a way someone could otherwise obtain a membership
 * without paying for it, or without paying the right amount, or by reusing one
 * payment twice.
 */

export const PAYMENT_VERIFIED_EVENT = 'PAYMENT_VERIFIED';

/** How far in the past a transfer may be and still count for this application. */
const MAX_TRANSFER_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerance for clock skew between the bank's clock and ours. */
const MAX_TRANSFER_SKEW_MS = 15 * 60 * 1000;
/** Below this, a masked account number does not identify an account. */
const MIN_RECEIVER_DIGITS = 4;

/**
 * Applicant-facing reasons (Issue #1 section 65).
 *
 * Each names the actual problem, because "payment verification failed" gives
 * the applicant nothing to act on and sends them to the association instead.
 */
export type PaymentFailureReason =
  | 'SLIP_UNREADABLE'
  | 'SLIP_NOT_FOUND'
  | 'DUPLICATE_SLIP'
  | 'AMOUNT_MISMATCH'
  | 'RECEIVER_MISMATCH'
  | 'TRANSFER_TOO_OLD'
  | 'TRANSFER_IN_FUTURE'
  | 'RECEIVER_UNVERIFIABLE'
  | 'MEMBERSHIP_NOT_SELECTED'
  | 'ALREADY_PAID'
  | 'NOT_AWAITING_PAYMENT'
  | 'PROVIDER_UNAVAILABLE';

const MESSAGES: Readonly<Record<PaymentFailureReason, string>> = {
  SLIP_UNREADABLE: 'อ่านข้อมูลจากสลิปไม่สำเร็จ กรุณาแนบสลิปที่เห็น QR ชัดเจน',
  SLIP_NOT_FOUND: 'ไม่พบรายการโอนนี้ในระบบธนาคาร กรุณาตรวจสอบสลิปอีกครั้ง',
  DUPLICATE_SLIP: 'สลิปนี้เคยถูกใช้แล้ว กรุณาใช้สลิปของรายการโอนที่ยังไม่ได้ใช้',
  AMOUNT_MISMATCH: 'ยอดเงินในสลิปไม่ตรงกับค่าบำรุงสมาชิกที่เลือกไว้',
  RECEIVER_MISMATCH: 'บัญชีผู้รับในสลิปไม่ตรงกับบัญชีของสมาคม กรุณาตรวจสอบการโอน',
  TRANSFER_TOO_OLD: 'รายการโอนนี้เก่าเกินกำหนด กรุณาโอนใหม่แล้วแนบสลิปอีกครั้ง',
  TRANSFER_IN_FUTURE: 'เวลาในสลิปไม่ถูกต้อง กรุณาตรวจสอบสลิปอีกครั้ง',
  RECEIVER_UNVERIFIABLE: 'ไม่สามารถยืนยันบัญชีผู้รับจากสลิปนี้ได้ กรุณาติดต่อสมาคมเพื่อตรวจสอบ',
  MEMBERSHIP_NOT_SELECTED: 'กรุณาเลือกประเภทสมาชิกก่อนแนบสลิป',
  ALREADY_PAID:
    'ใบสมัครนี้ได้รับการชำระเงินเรียบร้อยแล้ว หากท่านโอนเงินซ้ำ กรุณาติดต่อสมาคมเพื่อขอคืนเงิน',
  NOT_AWAITING_PAYMENT: 'ใบสมัครนี้ไม่อยู่ในขั้นตอนรอชำระเงิน กรุณาติดต่อสมาคมเพื่อตรวจสอบ',
  PROVIDER_UNAVAILABLE: 'ไม่สามารถตรวจสอบสลิปได้ในขณะนี้ กรุณาลองอีกครั้ง',
};

/** Thrown when a payment is not accepted. Carries a machine-readable reason. */
export class PaymentRejectedError extends ApiError {
  readonly reason: PaymentFailureReason;

  constructor(reason: PaymentFailureReason) {
    super(
      reason === 'PROVIDER_UNAVAILABLE' ? 'PROVIDER_UNAVAILABLE' : 'PAYMENT_REJECTED',
      MESSAGES[reason],
    );
    this.name = 'PaymentRejectedError';
    this.reason = reason;
  }
}

export interface AssociationAccount {
  /** Digits of the association's receiving account, formatting stripped. */
  accountDigits: string;
  bankName: string;
  accountName: string;
}

/**
 * Decides whether the slip's masked receiver account is the association's.
 *
 * Banks mask most of the number, and which part they leave visible differs
 * between them, so an equality check is not available. The visible digits must
 * appear in the configured account **in order**, which a different account
 * would fail unless it shared that subsequence.
 *
 * Fewer than four visible digits is treated as unverifiable rather than as a
 * match. Accepting it would mean approving a payment without knowing where the
 * money went, and for a payment path that is the wrong way to fail.
 */
export function receiverMatches(
  visibleDigits: string | null,
  account: AssociationAccount,
): 'MATCH' | 'MISMATCH' | 'UNVERIFIABLE' {
  if (!visibleDigits || visibleDigits.length < MIN_RECEIVER_DIGITS) {
    return 'UNVERIFIABLE';
  }

  const target = account.accountDigits.replace(/\D/g, '');
  if (target.length < MIN_RECEIVER_DIGITS) {
    return 'UNVERIFIABLE';
  }

  let cursor = 0;
  for (const digit of visibleDigits) {
    const found = target.indexOf(digit, cursor);
    if (found === -1) return 'MISMATCH';
    cursor = found + 1;
  }
  return 'MATCH';
}

export interface VerifyPaymentInput {
  applicationId: string;
  evidence: SlipEvidence;
}

export interface VerifiedPayment {
  payment: PaymentRecord;
  amountSatang: number;
  transactionRef: string;
}

export interface PaymentService {
  verify(input: VerifyPaymentInput): Promise<VerifiedPayment>;
}

export interface PaymentServiceOptions {
  now?: () => Date;
  maxTransferAgeMs?: number;
}

export function createPaymentService(
  db: Repository,
  provider: SlipVerificationProvider,
  stateMachine: StateMachine,
  audit: AuditLog,
  account: AssociationAccount,
  options: PaymentServiceOptions = {},
): PaymentService {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxTransferAgeMs ?? MAX_TRANSFER_AGE_MS;

  return {
    async verify(input) {
      let application = await db.applications.findById(input.applicationId);
      if (!application) {
        throw new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้ กรุณาเริ่มขั้นตอนใหม่');
      }

      // Compatibility repair for applications created before Issue #55. The
      // old membership PATCH stored the server-resolved plan but forgot the
      // DRAFT -> AWAITING_PAYMENT transition, leaving an applicant trapped on
      // a payment page that could never accept their slip. Repair only that
      // exact shape, through the normal state machine, before provider work.
      const legacyDraftHasNoPayment =
        application.status === 'DRAFT' &&
        application.membershipType !== null &&
        (await db.payments.findByApplicationId(input.applicationId)).length === 0;
      if (legacyDraftHasNoPayment) {
        await stateMachine.transition(input.applicationId, 'AWAITING_PAYMENT', {
          actorType: 'APPLICANT',
        });
        application = await db.applications.findById(input.applicationId);
        if (!application) {
          throw new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้ กรุณาเริ่มขั้นตอนใหม่');
        }
      }

      // Refuse before calling the provider if a payment is not expected.
      //
      // The state machine treats a repeat transition into PAYMENT_VERIFIED as an
      // idempotent no-op, which is right in general and wrong here: for this
      // service, "already verified" means the application has already been paid
      // for, and accepting a second, different slip would record a second
      // payment and tell the applicant it went through. Checking first also
      // avoids spending a paid provider call on a request that cannot succeed.
      if (application.status !== 'AWAITING_PAYMENT') {
        // Whether money has already been taken is answered by looking for a
        // payment, not by classifying the status. `REJECTED` in particular is
        // reachable both before and after payment, so a status list would tell
        // some applicants their money is refundable when they never paid, and
        // others the opposite.
        const alreadyPaid = (await db.payments.findByApplicationId(input.applicationId)).length > 0;
        await audit.record({
          applicationId: input.applicationId,
          eventType: 'PAYMENT_PRESENTED_WHEN_NOT_EXPECTED',
          actorType: 'APPLICANT',
          metadata: { from: application.status },
        });
        throw new PaymentRejectedError(alreadyPaid ? 'ALREADY_PAID' : 'NOT_AWAITING_PAYMENT');
      }

      // The expected amount comes from the membership type on the record, never
      // from the request. There is no code path where a client-supplied number
      // reaches this comparison.
      if (!application.membershipType) {
        throw new PaymentRejectedError('MEMBERSHIP_NOT_SELECTED');
      }
      const expectedAmount = membershipPlan(application.membershipType).amountSatang;

      const result = await provider.verify({
        evidence: input.evidence,
        expectedAmount,
      });

      if (!result.ok) {
        throw new PaymentRejectedError(
          result.reason === 'PROVIDER_ERROR' || result.reason === 'PROVIDER_TIMEOUT'
            ? 'PROVIDER_UNAVAILABLE'
            : result.reason,
        );
      }

      const transaction = result.transaction;

      // Check 3: the amount. SlipOK was told what to expect, but its answer is
      // not the last word on what the association was actually paid.
      const amountMatched = transaction.amount === expectedAmount;
      if (!amountMatched) {
        throw new PaymentRejectedError('AMOUNT_MISMATCH');
      }

      // Check 2: the receiver.
      const receiverOutcome = receiverMatches(transaction.receiverAccountDigits, account);
      if (receiverOutcome === 'MISMATCH') {
        throw new PaymentRejectedError('RECEIVER_MISMATCH');
      }
      if (receiverOutcome === 'UNVERIFIABLE') {
        throw new PaymentRejectedError('RECEIVER_UNVERIFIABLE');
      }

      // Check 5: the timestamp. A transfer from months ago is not payment for
      // this application, and one in the future is not a transfer at all.
      if (transaction.transactionAt) {
        const transferredAt = new Date(transaction.transactionAt).getTime();
        const currentTime = now().getTime();

        if (transferredAt - currentTime > MAX_TRANSFER_SKEW_MS) {
          throw new PaymentRejectedError('TRANSFER_IN_FUTURE');
        }
        if (currentTime - transferredAt > maxAgeMs) {
          throw new PaymentRejectedError('TRANSFER_TOO_OLD');
        }
      }

      // Check 4: not used before. The unique constraint decides, not a prior
      // read, so two slips arriving together cannot both be accepted.
      let payment: PaymentRecord;
      try {
        payment = await db.payments.create({
          applicationId: input.applicationId,
          provider: provider.name,
          transactionRef: transaction.transactionRef,
          amountSatang: transaction.amount,
          sendingBank: transaction.sendingBank,
          receivingBank: transaction.receivingBank,
          receiverAccountDigits: transaction.receiverAccountDigits,
          transactionAt: transaction.transactionAt,
          receiverMatched: true,
          amountMatched: true,
          verificationStatus: 'VERIFIED',
          verifiedAt: now().toISOString(),
        });
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          throw new PaymentRejectedError('DUPLICATE_SLIP');
        }
        throw error;
      }

      // The payment row exists before the status moves, so a failure here leaves
      // a recorded payment that can be reconciled rather than money received
      // with no trace.
      const outcome = await stateMachine.transition(input.applicationId, 'PAYMENT_VERIFIED', {
        actorType: 'SYSTEM',
        domainEvent: PAYMENT_VERIFIED_EVENT,
      });

      if (outcome.kind !== 'APPLIED') {
        // The status changed between the check above and this write. The payment
        // is real and is now recorded, so this needs a human rather than a
        // silent rollback.
        await audit.record({
          applicationId: input.applicationId,
          eventType: 'PAYMENT_RECORDED_OUT_OF_SEQUENCE',
          actorType: 'SYSTEM',
          // The outcome kind is the useful detail; the statuses are not all
          // present on every variant.
          metadata: { reason: outcome.kind, amountSatang: transaction.amount },
        });
        throw new ApiError(
          'CONFLICT',
          'ใบสมัครนี้ไม่อยู่ในขั้นตอนรอชำระเงิน กรุณาติดต่อสมาคมเพื่อตรวจสอบ',
        );
      }

      // An applicant may submit a clearer slip while a manual review is still
      // pending. Automatic verification wins safely and removes that item from
      // the manager queue without changing any of the payment checks above.
      await db.paymentReviews.resolveIfPending(input.applicationId, 'AUTOMATICALLY_VERIFIED');

      return {
        payment,
        amountSatang: transaction.amount,
        transactionRef: transaction.transactionRef,
      };
    },
  };
}
