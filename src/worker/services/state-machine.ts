import type { ApplicationStatus, Repository } from '../db';
import { toEventInput } from './audit';

/**
 * Application state machine (Issue #1 section 41).
 *
 * Three properties matter here and each is enforced rather than assumed:
 *
 * 1. **Validated** - a transition that is not in the table below is refused, so
 *    no code path can move an application from, say, `DRAFT` straight to
 *    `COMPLETED`.
 * 2. **Idempotent** - asking for a status the application already has is a
 *    no-op that records nothing. Resend can deliver the same webhook ten times
 *    and the manager can double-click a button; neither may produce a second
 *    audit event or a second email.
 * 3. **Concurrency-safe** - the write is a compare-and-set against the current
 *    status, so of two simultaneous requests exactly one applies the change.
 *    D1 has no interactive transaction to lean on.
 */

/**
 * Allowed target statuses for each status.
 *
 * The happy path follows Issue #1 section 41. Exception statuses are reachable
 * from the points where the corresponding real-world problem can be discovered:
 * a payment can only need a refund once money has been taken, and an
 * application can only be cancelled before that.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  DRAFT: ['AWAITING_PAYMENT', 'CANCELLED'],
  AWAITING_PAYMENT: ['PAYMENT_VERIFIED', 'CANCELLED', 'REJECTED'],
  PAYMENT_VERIFIED: ['SUBMITTED', 'REJECTED', 'REFUND_REQUIRED'],
  SUBMITTED: ['MANAGER_NOTIFIED', 'REJECTED', 'REFUND_REQUIRED'],
  MANAGER_NOTIFIED: ['NBTC_PROCESSING', 'REJECTED', 'REFUND_REQUIRED'],
  NBTC_PROCESSING: ['NBTC_RECORDED', 'REJECTED', 'REFUND_REQUIRED'],
  NBTC_RECORDED: ['COMPLETED'],
  COMPLETED: [],
  REJECTED: ['REFUND_REQUIRED'],
  CANCELLED: [],
  REFUND_REQUIRED: ['REFUNDED'],
  REFUNDED: [],
};

/** Statuses from which no further transition is possible. */
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = Object.entries(ALLOWED_TRANSITIONS)
  .filter(([, targets]) => targets.length === 0)
  .map(([status]) => status as ApplicationStatus);

export function allowedTargets(from: ApplicationStatus): readonly ApplicationStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function isTransitionAllowed(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Statuses that may legally precede `to`. */
export function predecessorsOf(to: ApplicationStatus): readonly ApplicationStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as ApplicationStatus[]).filter((from) =>
    ALLOWED_TRANSITIONS[from].includes(to),
  );
}

export const STATUS_CHANGED_EVENT = 'STATUS_CHANGED';

export type TransitionOutcome =
  | { kind: 'APPLIED'; from: ApplicationStatus; to: ApplicationStatus }
  /** The application already had the target status; nothing was written. */
  | { kind: 'ALREADY_IN_TARGET_STATE'; status: ApplicationStatus }
  | { kind: 'NOT_ALLOWED'; from: ApplicationStatus; to: ApplicationStatus }
  /**
   * Another request kept moving the row to a status from which the requested
   * transition is still legal, for more attempts than this service will make.
   * The caller may retry; nothing was written.
   */
  | { kind: 'CONCURRENTLY_MODIFIED'; status: ApplicationStatus; to: ApplicationStatus }
  | { kind: 'NOT_FOUND' };

/** Attempts before giving up and reporting `CONCURRENTLY_MODIFIED`. */
const MAX_ATTEMPTS = 3;

export interface TransitionOptions {
  /** Who caused the change. Defaults to the system. */
  actorType?: 'APPLICANT' | 'MANAGER' | 'SYSTEM' | 'PROVIDER';
  /** Manager identity for admin actions. */
  actorId?: string | null;
  /** Timestamps that belong to this transition. */
  timestamps?: {
    submittedAt?: string;
    managerAcknowledgedAt?: string;
    nbtcRecordedAt?: string;
    nbtcRecordedBy?: string;
  };
  /**
   * Domain event recorded alongside `STATUS_CHANGED`, e.g. `PAYMENT_VERIFIED`.
   * Recorded only when the transition actually applies.
   */
  domainEvent?: string;
}

export interface StateMachine {
  transition(
    applicationId: string,
    to: ApplicationStatus,
    options?: TransitionOptions,
  ): Promise<TransitionOutcome>;
}

export function createStateMachine(db: Repository): StateMachine {
  return {
    async transition(applicationId, to, options = {}) {
      for (let attempt = 1; ; attempt += 1) {
        const application = await db.applications.findById(applicationId);
        if (!application) {
          return { kind: 'NOT_FOUND' };
        }

        const from = application.status;

        if (from === to) {
          return { kind: 'ALREADY_IN_TARGET_STATE', status: to };
        }

        if (!isTransitionAllowed(from, to)) {
          return { kind: 'NOT_ALLOWED', from, to };
        }

        const actorType = options.actorType ?? 'SYSTEM';
        const actorId = options.actorId ?? null;

        // The domain event comes first so the trail reads in causal order:
        // PAYMENT_VERIFIED, then STATUS_CHANGED.
        const events = [
          ...(options.domainEvent
            ? [toEventInput({ applicationId, eventType: options.domainEvent, actorType, actorId })]
            : []),
          toEventInput({
            applicationId,
            eventType: STATUS_CHANGED_EVENT,
            actorType,
            actorId,
            metadata: { from, to },
          }),
        ];

        // Compare-and-set against the exact status that was read, not against
        // every legal predecessor. Guarding on the wider set would let the write
        // succeed after a concurrent request had already moved the row, and the
        // audit event would then record a `from` that was never true.
        //
        // Status and events go in one transaction, so a transition can never
        // exist without its trail.
        const applied = await db.applications.transitionStatus({
          id: applicationId,
          from,
          to,
          timestamps: options.timestamps ?? {},
          events,
        });

        if (!applied) {
          // Another request won the race. Decide from fresh state rather than
          // guessing, and retry while the requested transition is still legal.
          if (attempt < MAX_ATTEMPTS) continue;

          const current = await db.applications.findById(applicationId);
          if (!current) return { kind: 'NOT_FOUND' };
          if (current.status === to) {
            return { kind: 'ALREADY_IN_TARGET_STATE', status: to };
          }
          if (isTransitionAllowed(current.status, to)) {
            return { kind: 'CONCURRENTLY_MODIFIED', status: current.status, to };
          }
          return { kind: 'NOT_ALLOWED', from: current.status, to };
        }

        return { kind: 'APPLIED', from, to };
      }
    },
  };
}
