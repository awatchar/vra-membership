import { UniqueConstraintError } from '../db';
import type { PaymentRecord, PaymentReviewRecord, Repository } from '../db';
import { ApiError } from '../lib/http';
import type { AuditLog } from './audit';
import type { EmailOutcome, EmailService } from './email';
import { membershipPlan } from './membership';
import { PAYMENT_VERIFIED_EVENT } from './payment';
import type { AssociationAccount } from './payment';
import type { StateMachine } from './state-machine';

export const PAYMENT_MANUAL_REVIEW_REQUESTED_EVENT = 'PAYMENT_MANUAL_REVIEW_REQUESTED';
export const PAYMENT_MANUAL_REVIEW_APPROVED_EVENT = 'PAYMENT_MANUAL_REVIEW_APPROVED';

const TRANSACTION_REFERENCE = /^[A-Z0-9._/-]{6,100}$/;

export interface ManualReviewRequest {
  review: PaymentReviewRecord;
  created: boolean;
  notificationSent: boolean;
}

export interface ManualPaymentApproval {
  payment: PaymentRecord;
  amountSatang: number;
}

export interface PaymentReviewService {
  request(applicationId: string): Promise<ManualReviewRequest>;
  approve(
    applicationId: string,
    transactionRef: string,
    actorId: string,
  ): Promise<ManualPaymentApproval>;
}

function acceptedEmail(status: string): boolean {
  return status !== 'QUEUED' && status !== 'FAILED';
}

/** Normalizes a bank reference without ever placing it in an event or log. */
function normalizeReference(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!TRANSACTION_REFERENCE.test(normalized)) {
    throw new ApiError(
      'BAD_REQUEST',
      'กรุณากรอกเลขอ้างอิงธุรกรรม 6–100 ตัว โดยใช้ตัวอักษร ตัวเลข จุด ขีด หรือเครื่องหมายทับ',
    );
  }
  return normalized;
}

export function createPaymentReviewService(
  db: Repository,
  emails: EmailService,
  stateMachine: StateMachine,
  audit: AuditLog,
  account: AssociationAccount,
  now: () => Date = () => new Date(),
): PaymentReviewService {
  return {
    async request(applicationId) {
      const application = await db.applications.findById(applicationId);
      if (!application) throw new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้');
      if (application.status !== 'AWAITING_PAYMENT' || !application.membershipType) {
        throw new ApiError('CONFLICT', 'ใบสมัครนี้ไม่อยู่ในขั้นตอนรอตรวจสอบการชำระเงิน');
      }

      const { record, created } = await db.paymentReviews.createIfMissing(applicationId);
      if (created) {
        await audit.record({
          applicationId,
          eventType: PAYMENT_MANUAL_REVIEW_REQUESTED_EVENT,
          actorType: 'APPLICANT',
          metadata: { reason: 'SLIP_UNREADABLE' },
        });
      }

      const existing = await db.emails.findByApplicationIdAndType(
        applicationId,
        'MANAGER_PAYMENT_REVIEW',
      );
      let notification: EmailOutcome | null = null;
      if (!existing.some((email) => acceptedEmail(email.status))) {
        const retryable = existing.find(
          (email) => email.status === 'QUEUED' || email.status === 'FAILED',
        );
        notification = retryable
          ? await emails.retry(retryable.id)
          : await emails.sendManagerPaymentReview(applicationId);
      }

      return {
        review: record,
        created,
        notificationSent:
          existing.some((email) => acceptedEmail(email.status)) || notification?.ok === true,
      };
    },

    async approve(applicationId, rawTransactionRef, actorId) {
      const transactionRef = normalizeReference(rawTransactionRef);
      const application = await db.applications.findById(applicationId);
      if (!application) throw new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้');
      if (application.status !== 'AWAITING_PAYMENT' || !application.membershipType) {
        throw new ApiError('CONFLICT', 'ใบสมัครนี้ไม่อยู่ในขั้นตอนรอตรวจสอบการชำระเงิน');
      }

      const review = await db.paymentReviews.findByApplicationId(applicationId);
      if (!review || review.status !== 'PENDING') {
        throw new ApiError('CONFLICT', 'ไม่มีคำขอตรวจสอบการชำระเงินที่รอดำเนินการ');
      }
      if ((await db.payments.findByApplicationId(applicationId)).length > 0) {
        throw new ApiError('CONFLICT', 'ใบสมัครนี้มีรายการชำระเงินแล้ว');
      }

      const amountSatang = membershipPlan(application.membershipType).amountSatang;
      let payment: PaymentRecord;
      try {
        payment = await db.payments.create({
          applicationId,
          provider: 'manual-bank-statement',
          transactionRef,
          amountSatang,
          sendingBank: null,
          receivingBank: account.bankName,
          receiverAccountDigits: account.accountDigits.replace(/\D/g, '').slice(-4) || null,
          transactionAt: null,
          receiverMatched: true,
          amountMatched: true,
          verificationStatus: 'VERIFIED',
          verifiedAt: now().toISOString(),
        });
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          if (error.constraintName.includes('application_id')) {
            throw new ApiError('CONFLICT', 'ใบสมัครนี้มีรายการชำระเงินแล้ว');
          }
          throw new ApiError('CONFLICT', 'เลขอ้างอิงธุรกรรมนี้ถูกใช้ยืนยันการชำระเงินแล้ว');
        }
        throw error;
      }

      const transition = await stateMachine.transition(applicationId, 'PAYMENT_VERIFIED', {
        actorType: 'MANAGER',
        actorId,
        domainEvent: PAYMENT_VERIFIED_EVENT,
      });
      if (transition.kind !== 'APPLIED') {
        await audit.record({
          applicationId,
          eventType: 'PAYMENT_RECORDED_OUT_OF_SEQUENCE',
          actorType: 'SYSTEM',
          metadata: { reason: transition.kind, amountSatang },
        });
        throw new ApiError('CONFLICT', 'สถานะใบสมัครเปลี่ยนระหว่างการยืนยัน กรุณาตรวจสอบรายการ');
      }

      await db.paymentReviews.resolveIfPending(applicationId, 'APPROVED', actorId);
      await audit.record({
        applicationId,
        eventType: PAYMENT_MANUAL_REVIEW_APPROVED_EVENT,
        actorType: 'MANAGER',
        actorId,
        metadata: { amountSatang, provider: 'manual-bank-statement' },
      });

      return { payment, amountSatang };
    },
  };
}
