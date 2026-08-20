import type { ActorType, ApplicationEventInput, EventMetadata, Repository } from '../db';

/**
 * Audit trail.
 *
 * `application_events` is the record of what happened to an application
 * (Issue #1 sections 49-50). It is written on every state change and by every
 * service that performs a meaningful action.
 *
 * Metadata uses the same defence as the logger: an allowlist of keys, primitive
 * values only. `EventMetadata` already restricts value types at compile time,
 * but the allowlist is what stops a future caller from appending a name, an
 * address, a citizen ID or an email address to the audit trail - which would
 * turn the trail itself into a store of personal data.
 */

const ALLOWED_METADATA_KEYS = [
  'from',
  'to',
  'source',
  'membershipType',
  'amountSatang',
  'referenceNo',
  'receiptNo',
  'emailType',
  'provider',
  'providerStatus',
  'reason',
  'attempt',
  'count',
] as const;

export type AuditMetadataKey = (typeof ALLOWED_METADATA_KEYS)[number];

const ALLOWED_METADATA_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_METADATA_KEYS);

/** Longest value accepted for a metadata string, to bound row growth. */
const MAX_METADATA_STRING_LENGTH = 64;

export function sanitizeAuditMetadata(
  metadata: EventMetadata | undefined,
): EventMetadata | undefined {
  if (metadata === undefined) return undefined;

  const result: EventMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ALLOWED_METADATA_KEY_SET.has(key)) continue;
    if (typeof value === 'string') {
      if (value.length > MAX_METADATA_STRING_LENGTH) continue;
      result[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export interface AuditEventInput {
  applicationId: string;
  eventType: string;
  actorType: ActorType;
  /** Manager identity for admin actions; never an applicant's personal data. */
  actorId?: string | null;
  metadata?: Partial<Record<AuditMetadataKey, string | number | boolean>>;
}

export interface AuditLog {
  record(input: AuditEventInput): Promise<void>;
  /** Appends `eventType` only if the application has no such event yet. */
  recordOnce(input: AuditEventInput): Promise<boolean>;
}

/** Shape accepted by the repository, with metadata already sanitised. */
export function toEventInput(input: AuditEventInput): ApplicationEventInput {
  const metadata = sanitizeAuditMetadata(input.metadata);
  return {
    applicationId: input.applicationId,
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    ...(metadata ? { metadata } : {}),
  };
}

export function createAuditLog(db: Repository): AuditLog {
  // Standalone functions rather than methods that reach for `this`, so a
  // destructured `const { recordOnce } = audit` keeps working.
  const record = async (input: AuditEventInput): Promise<void> => {
    await db.events.append(toEventInput(input));
  };

  const recordOnce = async (input: AuditEventInput): Promise<boolean> => {
    // Not atomic on its own; callers that must be exactly-once pair this with
    // a compare-and-set on the row the event describes.
    if (await db.events.existsForApplication(input.applicationId, input.eventType)) {
      return false;
    }
    await record(input);
    return true;
  };

  return { record, recordOnce };
}
