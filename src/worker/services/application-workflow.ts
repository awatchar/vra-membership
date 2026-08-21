import type { ApplicationRecord, EmailRecord, EmailType, Repository } from '../db';
import { ApiError } from '../lib/http';
import type { EmailOutcome, EmailService } from './email';
import type { NumberingService } from './numbering';
import type { ReceiptService } from './receipt';
import type { StateMachine } from './state-machine';

/**
 * What happens after a payment is verified (Issue #1 section 28).
 *
 * The applicant does not press submit again. Once the money is confirmed the
 * system carries the application the rest of the way on its own:
 *
 *   PAYMENT_VERIFIED -> number assigned -> RECEIPT_ISSUED
 *     -> RECEIPT_EMAIL_SENT -> APPLICATION_SUBMITTED -> MANAGER_EMAIL_SENT
 *
 * Two properties govern every line of this module.
 *
 * **Nothing already done is done again, and there is no progress column.** Each
 * step decides whether it has already happened by looking at what it would have
 * produced: a reference number on the row, a receipt for the application, a sent
 * email of that type, the status itself. A `current_step` column would be a
 * second source of truth that can disagree with the first, and it is the first
 * that matters.
 *
 * **A step that fails does not undo the steps before it.** By the time this runs
 * the association has the money. If Resend is down, the receipt is still issued
 * and the application is still submitted; the email rows carry their own failure
 * and can be retried. `resume` picks up exactly where the previous attempt
 * stopped, so a provider outage costs a retry rather than a lost payment.
 */

export const WORKFLOW_STEPS = [
  'APPLICATION_NUMBER',
  'RECEIPT',
  'RECEIPT_EMAIL',
  'SUBMISSION',
  'MANAGER_EMAIL',
] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export type StepState =
  /** Completed by this run. */
  | 'DONE'
  /** Was already complete before this run; nothing was repeated. */
  | 'ALREADY_DONE'
  /** Attempted and failed. A later `resume` will try it again. */
  | 'FAILED'
  /** Not attempted, because an earlier step it depends on did not complete. */
  | 'SKIPPED';

export interface WorkflowReport {
  applicationId: string;
  /** Null only if the very first step failed. */
  referenceNo: string | null;
  receiptNo: string | null;
  status: ApplicationRecord['status'];
  steps: Record<WorkflowStep, StepState>;
  /** True when every step is `DONE` or `ALREADY_DONE`. */
  complete: boolean;
}

export const APPLICATION_SUBMITTED_EVENT = 'APPLICATION_SUBMITTED';
export const MANAGER_NOTIFIED_EVENT = 'MANAGER_NOTIFIED';

/**
 * Thrown for an unknown application.
 *
 * An `ApiError` rather than a bespoke class so the entrypoint maps it to 404
 * without a per-service branch - a custom error here surfaced as a 500 and told
 * the caller nothing.
 */
export function workflowApplicationNotFound(): ApiError {
  return new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้');
}

export interface ApplicationWorkflow {
  /**
   * Runs every step that has not already completed, and reports each one.
   *
   * Safe to call repeatedly: this is both the path taken straight after
   * verification and the way a stalled application is finished later.
   */
  resume(applicationId: string): Promise<WorkflowReport>;
  /** The same report without attempting anything, for the confirmation page. */
  inspect(applicationId: string): Promise<WorkflowReport>;
}

/** An email of this type that the provider accepted. */
function acceptedEmail(rows: readonly EmailRecord[]): EmailRecord | null {
  return rows.find((row) => row.status !== 'QUEUED' && row.status !== 'FAILED') ?? null;
}

/** The row a retry should reuse, so the provider deduplicates it. */
function retryableEmail(rows: readonly EmailRecord[]): EmailRecord | null {
  return rows.find((row) => row.status === 'QUEUED' || row.status === 'FAILED') ?? null;
}

/**
 * Statuses at or past submission. Reaching one means the submission step has
 * happened, whatever has become of the application since.
 */
const SUBMITTED_OR_LATER: readonly ApplicationRecord['status'][] = [
  'SUBMITTED',
  'MANAGER_NOTIFIED',
  'NBTC_PROCESSING',
  'NBTC_RECORDED',
  'COMPLETED',
];

const NOTIFIED_OR_LATER: readonly ApplicationRecord['status'][] = [
  'MANAGER_NOTIFIED',
  'NBTC_PROCESSING',
  'NBTC_RECORDED',
  'COMPLETED',
];

export function createApplicationWorkflow(
  db: Repository,
  machine: StateMachine,
  numbering: NumberingService,
  receipts: ReceiptService,
  emails: EmailService,
): ApplicationWorkflow {
  const load = async (applicationId: string): Promise<ApplicationRecord> => {
    const application = await db.applications.findById(applicationId);
    if (!application) throw workflowApplicationNotFound();
    return application;
  };

  /**
   * Sends an email of `type` unless one has already been accepted, reusing a
   * failed row so the provider's idempotency key stays the same.
   */
  const ensureEmail = async (
    applicationId: string,
    type: EmailType,
    send: () => Promise<EmailOutcome>,
  ): Promise<StepState> => {
    const rows = await db.emails.findByApplicationIdAndType(applicationId, type);
    if (acceptedEmail(rows)) return 'ALREADY_DONE';

    const pending = retryableEmail(rows);
    const outcome = pending ? await emails.retry(pending.id) : await send();
    return outcome.ok ? 'DONE' : 'FAILED';
  };

  const report = async (
    application: ApplicationRecord,
    steps: Record<WorkflowStep, StepState>,
  ): Promise<WorkflowReport> => {
    const receipt = await db.receipts.findByApplicationId(application.id);
    const current = await load(application.id);

    return {
      applicationId: current.id,
      referenceNo: current.referenceNo,
      receiptNo: receipt?.receiptNo ?? null,
      status: current.status,
      steps,
      complete: WORKFLOW_STEPS.every(
        (step) => steps[step] === 'DONE' || steps[step] === 'ALREADY_DONE',
      ),
    };
  };

  return {
    async resume(applicationId) {
      const application = await load(applicationId);
      const steps: Record<WorkflowStep, StepState> = {
        APPLICATION_NUMBER: 'SKIPPED',
        RECEIPT: 'SKIPPED',
        RECEIPT_EMAIL: 'SKIPPED',
        SUBMISSION: 'SKIPPED',
        MANAGER_EMAIL: 'SKIPPED',
      };

      // The number is first because the receipt and both emails print it. An
      // application that reached payment without one would put "ยังไม่ออกเลขที่
      // ใบสมัคร" on a document the member keeps.
      if (application.referenceNo) {
        steps.APPLICATION_NUMBER = 'ALREADY_DONE';
      } else {
        try {
          await numbering.assignApplicationNumber(applicationId);
          steps.APPLICATION_NUMBER = 'DONE';
        } catch {
          // Nothing downstream can be produced correctly without it, so the
          // run stops here rather than issuing a receipt with no number on it.
          steps.APPLICATION_NUMBER = 'FAILED';
          return report(application, steps);
        }
      }

      try {
        const issued = await receipts.issue(applicationId);
        steps.RECEIPT = issued.created ? 'DONE' : 'ALREADY_DONE';
      } catch {
        // The receipt is the member's proof that the money was received. The
        // rest of the flow is about telling people, which is worth less than
        // getting this right, so a failure here stops the run.
        steps.RECEIPT = 'FAILED';
        return report(application, steps);
      }

      steps.RECEIPT_EMAIL = await ensureEmail(applicationId, 'RECEIPT', () =>
        emails.sendReceipt(applicationId),
      );

      // Submission happens whether or not the receipt email went out. The
      // application is complete from the applicant's side either way, and
      // holding it back because a provider was down would leave it invisible to
      // the manager.
      if (SUBMITTED_OR_LATER.includes(application.status)) {
        steps.SUBMISSION = 'ALREADY_DONE';
      } else {
        const outcome = await machine.transition(applicationId, 'SUBMITTED', {
          actorType: 'SYSTEM',
          domainEvent: APPLICATION_SUBMITTED_EVENT,
          timestamps: { submittedAt: new Date().toISOString() },
        });
        steps.SUBMISSION =
          outcome.kind === 'APPLIED'
            ? 'DONE'
            : outcome.kind === 'ALREADY_IN_TARGET_STATE'
              ? 'ALREADY_DONE'
              : 'FAILED';
        if (steps.SUBMISSION === 'FAILED') return report(application, steps);
      }

      steps.MANAGER_EMAIL = await ensureEmail(applicationId, 'MANAGER_NEW_APPLICATION', () =>
        emails.sendManagerNewApplication(applicationId),
      );

      // `MANAGER_NOTIFIED` states that the manager has been told, so it is only
      // recorded when an email was actually accepted. Recording it after a
      // failed send would make the application look handled when nobody has
      // heard about it - and #14 keys the manager's open off that status.
      if (steps.MANAGER_EMAIL === 'DONE' || steps.MANAGER_EMAIL === 'ALREADY_DONE') {
        if (!NOTIFIED_OR_LATER.includes(application.status)) {
          await machine.transition(applicationId, 'MANAGER_NOTIFIED', {
            actorType: 'SYSTEM',
            domainEvent: MANAGER_NOTIFIED_EVENT,
          });
        }
      }

      // No summary event: the sequence in Issue #1 section 50 already ends with
      // `MANAGER_EMAIL_SENT`, and a `WORKFLOW_COMPLETED` row would say nothing
      // the preceding rows do not.
      return report(application, steps);
    },

    async inspect(applicationId) {
      const application = await load(applicationId);
      const [receipt, receiptEmails, managerEmails] = await Promise.all([
        db.receipts.findByApplicationId(applicationId),
        db.emails.findByApplicationIdAndType(applicationId, 'RECEIPT'),
        db.emails.findByApplicationIdAndType(applicationId, 'MANAGER_NEW_APPLICATION'),
      ]);

      const state = (done: boolean, attempted: boolean): StepState =>
        done ? 'ALREADY_DONE' : attempted ? 'FAILED' : 'SKIPPED';

      return report(application, {
        APPLICATION_NUMBER: application.referenceNo ? 'ALREADY_DONE' : 'SKIPPED',
        RECEIPT: receipt ? 'ALREADY_DONE' : 'SKIPPED',
        RECEIPT_EMAIL: state(acceptedEmail(receiptEmails) !== null, receiptEmails.length > 0),
        SUBMISSION: SUBMITTED_OR_LATER.includes(application.status) ? 'ALREADY_DONE' : 'SKIPPED',
        MANAGER_EMAIL: state(acceptedEmail(managerEmails) !== null, managerEmails.length > 0),
      });
    },
  };
}
