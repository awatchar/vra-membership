import type { ApplicationRecord, Repository } from '../db';
import { ApiError } from '../lib/http';
import type { EmailService } from './email';
import type { StateMachine, TransitionOutcome } from './state-machine';

/**
 * Recording the NBTC registration (Issue #1 sections 37-40).
 *
 * The manager does the registration by hand in the regulator's own system and
 * then confirms it here. That confirmation is the last thing anyone has to do,
 * and it produces three effects in order: the record, the member's completion
 * email, and the final status.
 *
 *   NBTC_RECORDED -> MEMBER_COMPLETION_EMAIL_SENT -> COMPLETED
 *
 * The shape mirrors the post-payment workflow, for the same reasons. Each step
 * asks what it would have produced rather than reading a progress marker, so
 * calling this twice is safe and calling it again after a provider outage
 * finishes the part that did not happen. `COMPLETED` is only recorded once the
 * member has actually been told, because that is what the status claims.
 *
 * The manager's identity is stored on the row and on the audit event. It is the
 * only place a staff member's identity is persisted, and it is required: a
 * registration with the regulator has to be attributable to the person who made
 * it.
 */

export const MANAGER_CONFIRMED_EVENT = 'MANAGER_CONFIRMED_NBTC_RECORD';

/**
 * Thrown for an unknown application.
 *
 * An `ApiError` rather than a bespoke class so the entrypoint maps it to 404
 * without a per-service branch - a custom error here surfaced as a 500 and told
 * the caller nothing.
 */
export function nbtcApplicationNotFound(): ApiError {
  return new ApiError('NOT_FOUND', 'ไม่พบใบสมัครนี้');
}

export type NbtcStepState = 'DONE' | 'ALREADY_DONE' | 'FAILED' | 'SKIPPED';

export interface NbtcCompletionReport {
  applicationId: string;
  status: ApplicationRecord['status'];
  recorded: NbtcStepState;
  completionEmail: NbtcStepState;
  completed: NbtcStepState;
  /** True when all three steps are done. */
  complete: boolean;
}

export interface NbtcCompletionService {
  /**
   * Records the registration and finishes the application.
   *
   * Idempotent: a second confirmation, or a retry after the email provider
   * failed, does only the part that is still missing.
   */
  confirm(applicationId: string, managerIdentity: string): Promise<NbtcCompletionReport>;
}

const RECORDED_OR_LATER: readonly ApplicationRecord['status'][] = ['NBTC_RECORDED', 'COMPLETED'];

function stateFor(outcome: TransitionOutcome): NbtcStepState {
  if (outcome.kind === 'APPLIED') return 'DONE';
  if (outcome.kind === 'ALREADY_IN_TARGET_STATE') return 'ALREADY_DONE';
  return 'FAILED';
}

export function createNbtcCompletion(
  db: Repository,
  machine: StateMachine,
  emails: EmailService,
  options: { now?: () => Date } = {},
): NbtcCompletionService {
  const now = options.now ?? (() => new Date());

  return {
    async confirm(applicationId, managerIdentity) {
      const application = await db.applications.findById(applicationId);
      if (!application) throw nbtcApplicationNotFound();

      const report: NbtcCompletionReport = {
        applicationId,
        status: application.status,
        recorded: 'SKIPPED',
        completionEmail: 'SKIPPED',
        completed: 'SKIPPED',
        complete: false,
      };

      if (RECORDED_OR_LATER.includes(application.status)) {
        report.recorded = 'ALREADY_DONE';
      } else {
        const outcome = await machine.transition(applicationId, 'NBTC_RECORDED', {
          actorType: 'MANAGER',
          actorId: managerIdentity,
          domainEvent: MANAGER_CONFIRMED_EVENT,
          timestamps: {
            nbtcRecordedAt: now().toISOString(),
            nbtcRecordedBy: managerIdentity,
          },
        });
        report.recorded = stateFor(outcome);
        if (report.recorded === 'FAILED') {
          const current = await db.applications.findById(applicationId);
          report.status = current?.status ?? application.status;
          return report;
        }
      }

      const existing = await db.emails.findByApplicationIdAndType(
        applicationId,
        'MEMBER_NBTC_COMPLETED',
      );
      const accepted = existing.find((row) => row.status !== 'QUEUED' && row.status !== 'FAILED');

      if (accepted) {
        report.completionEmail = 'ALREADY_DONE';
      } else {
        const pending = existing[0];
        const outcome = pending
          ? await emails.retry(pending.id)
          : await emails.sendMemberCompleted(applicationId);
        report.completionEmail = outcome.ok ? 'DONE' : 'FAILED';
      }

      // `COMPLETED` is the end of the process as the member experiences it, so
      // it waits for the message that tells them. The registration itself is
      // already recorded and cannot be lost by stopping here.
      if (report.completionEmail === 'DONE' || report.completionEmail === 'ALREADY_DONE') {
        const outcome = await machine.transition(applicationId, 'COMPLETED', {
          actorType: 'SYSTEM',
        });
        report.completed = stateFor(outcome);
      }

      const current = await db.applications.findById(applicationId);
      report.status = current?.status ?? application.status;
      // The email step is the only one that can be `FAILED` at this point: the
      // record step returns early on failure, and `completed` is only reached
      // once the email succeeded.
      report.complete = report.completed === 'DONE' || report.completed === 'ALREADY_DONE';

      return report;
    },
  };
}
