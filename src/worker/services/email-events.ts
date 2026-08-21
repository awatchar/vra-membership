import { z } from 'zod';
import type { EmailRecord, Repository } from '../db';
import type { AuditLog } from './audit';
import type { EmailService } from './email';
import type { StateMachine, TransitionOutcome } from './state-machine';

/**
 * Resend delivery events, and the one state change they can cause
 * (Issue #1 sections 33, 34 and 56).
 *
 * Two entry points lead to `NBTC_PROCESSING`: the manager opening the
 * notification email, and the manager pressing the button in it. Both live in
 * this module on purpose. The requirement is that the member receives the
 * processing email **exactly once** no matter which arrives first or how many
 * times, and that is only checkable if both paths go through the same guard.
 *
 * That guard is the state machine's compare-and-set. Only the caller whose
 * transition reports `APPLIED` sends the email, so ten replayed `email.opened`
 * events and a simultaneous button press between them still produce one
 * message. The alternative - reading the status and then deciding - has a
 * window between the read and the write where both callers see the same thing.
 *
 * Resend delivers at least once and its own documentation warns that events may
 * arrive out of order, so nothing here assumes a sequence: every effect is
 * idempotent on its own.
 */

/** Events this system acts on. Everything else is acknowledged and ignored. */
export const HANDLED_EVENT_TYPES = [
  'email.sent',
  'email.delivered',
  'email.opened',
  'email.clicked',
  'email.bounced',
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

/**
 * The envelope, narrowed to the two fields that matter.
 *
 * `data.email_id` is Resend's own id, which the `emails` row stored when the
 * message was accepted. Everything else in the payload - addresses, subject,
 * bounce text - is deliberately not read: it would be personal data arriving
 * from outside with nowhere to go.
 */
export const resendEventSchema = z.object({
  type: z.string().min(1).max(64),
  created_at: z.string().min(1).max(64).optional(),
  data: z.object({ email_id: z.string().min(1).max(128) }).passthrough(),
});

export type ResendEvent = z.infer<typeof resendEventSchema>;

export const MANAGER_EMAIL_OPENED_EVENT = 'MANAGER_EMAIL_OPENED';
export const MANAGER_ACKNOWLEDGED_EVENT = 'MANAGER_ACKNOWLEDGED';

export type EmailEventOutcome =
  /** Malformed body. Acknowledged so the provider stops retrying it. */
  | { kind: 'UNPARSEABLE' }
  /** A real Resend event this system has no use for. */
  | { kind: 'UNSUPPORTED'; eventType: string }
  /** Signed and well-formed, but no row matches - a message from elsewhere. */
  | { kind: 'UNKNOWN_EMAIL'; eventType: HandledEventType }
  | {
      kind: 'RECORDED';
      eventType: HandledEventType;
      emailId: string;
      /** False for a replay: the effect had already been recorded. */
      firstOccurrence: boolean;
      /** True only for the caller whose transition applied. */
      advancedToProcessing: boolean;
      processingEmailSent: boolean;
    };

export interface AcknowledgeOutcome {
  transition: TransitionOutcome;
  processingEmailSent: boolean;
}

export interface EmailEventService {
  /**
   * Handles one webhook event. Never throws for anything the provider could
   * send: an unknown event or an unmatched id is a recorded non-action, because
   * a non-2xx answer only makes Resend redeliver it for hours.
   */
  handle(body: unknown): Promise<EmailEventOutcome>;
  /**
   * The manager's explicit "start work" action (Issue #1 section 34), which
   * reaches the same status without a second member email. Called by the admin
   * route in #16.
   */
  acknowledgeByManager(applicationId: string, actorId: string): Promise<AcknowledgeOutcome>;
}

function isHandled(eventType: string): eventType is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(eventType);
}

export function createEmailEventService(
  db: Repository,
  machine: StateMachine,
  emails: EmailService,
  audit: AuditLog,
): EmailEventService {
  /**
   * Moves an application into `NBTC_PROCESSING` and sends the member's notice,
   * but only if this caller is the one that changed the status.
   */
  const enterProcessing = async (
    applicationId: string,
    cause: { domainEvent: string; actorType: 'PROVIDER' | 'MANAGER'; actorId?: string },
  ): Promise<AcknowledgeOutcome> => {
    const transition = await machine.transition(applicationId, 'NBTC_PROCESSING', {
      actorType: cause.actorType,
      ...(cause.actorId === undefined ? {} : { actorId: cause.actorId }),
      domainEvent: cause.domainEvent,
      timestamps: { managerAcknowledgedAt: new Date().toISOString() },
    });

    if (transition.kind !== 'APPLIED') {
      return { transition, processingEmailSent: false };
    }

    // A failed email must not undo the status change: the manager really has
    // started work, and the member's notice can be retried from its own row.
    const outcome = await emails.sendMemberProcessing(applicationId);
    return { transition, processingEmailSent: outcome.ok };
  };

  /** The first open of a manager notification is the signal; later ones are not. */
  const handleOpen = async (record: EmailRecord): Promise<EmailEventOutcome> => {
    const firstOccurrence = await db.emails.recordFirstOpen(record.id);

    if (!firstOccurrence || record.type !== 'MANAGER_NEW_APPLICATION') {
      return {
        kind: 'RECORDED',
        eventType: 'email.opened',
        emailId: record.id,
        firstOccurrence,
        advancedToProcessing: false,
        processingEmailSent: false,
      };
    }

    const { transition, processingEmailSent } = await enterProcessing(record.applicationId, {
      domainEvent: MANAGER_EMAIL_OPENED_EVENT,
      actorType: 'PROVIDER',
    });

    return {
      kind: 'RECORDED',
      eventType: 'email.opened',
      emailId: record.id,
      firstOccurrence,
      advancedToProcessing: transition.kind === 'APPLIED',
      processingEmailSent,
    };
  };

  const simple = (
    eventType: HandledEventType,
    record: EmailRecord,
    firstOccurrence: boolean,
  ): EmailEventOutcome => ({
    kind: 'RECORDED',
    eventType,
    emailId: record.id,
    firstOccurrence,
    advancedToProcessing: false,
    processingEmailSent: false,
  });

  return {
    async handle(body) {
      const parsed = resendEventSchema.safeParse(body);
      if (!parsed.success) return { kind: 'UNPARSEABLE' };

      const event = parsed.data;
      if (!isHandled(event.type)) return { kind: 'UNSUPPORTED', eventType: event.type };

      const record = await db.emails.findByProviderEmailId(event.data.email_id);
      if (!record) return { kind: 'UNKNOWN_EMAIL', eventType: event.type };

      switch (event.type) {
        case 'email.sent':
          // Our own send already recorded this row as sent, with the id this
          // event is keyed by. Touching the status again could only move it
          // backwards from `DELIVERED` if the events arrived out of order.
          return simple('email.sent', record, false);

        case 'email.delivered':
          await db.emails.markDelivered(record.id);
          return simple('email.delivered', record, record.deliveredAt === null);

        case 'email.bounced':
          await db.emails.markBounced(record.id);
          await audit.record({
            applicationId: record.applicationId,
            eventType: 'EMAIL_BOUNCED',
            actorType: 'PROVIDER',
            metadata: { emailType: record.type, provider: record.provider },
          });
          return simple('email.bounced', record, record.status !== 'BOUNCED');

        case 'email.clicked': {
          const first = await db.emails.recordFirstClick(record.id);
          return simple('email.clicked', record, first);
        }

        case 'email.opened':
          return handleOpen(record);
      }
    },

    acknowledgeByManager(applicationId, actorId) {
      return enterProcessing(applicationId, {
        domainEvent: MANAGER_ACKNOWLEDGED_EVENT,
        actorType: 'MANAGER',
        actorId,
      });
    },
  };
}
