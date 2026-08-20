/**
 * Database error translation.
 *
 * D1 surfaces constraint violations as opaque messages. Translating them here
 * keeps the rest of the application free of string matching.
 *
 * For unique violations the driver message is dropped entirely and only the
 * constraint name is carried forward, because that message quotes the value
 * that collided. Other failures are rethrown unchanged: their messages name a
 * table or a constraint, not a value, and they are only ever surfaced as an
 * error code by the top-level handler, never logged or returned to a client.
 */

export class UniqueConstraintError extends Error {
  /** Logical name of the constraint, e.g. `payments.transaction_ref`. */
  readonly constraintName: string;

  constructor(constraintName: string) {
    super(`Unique constraint violated: ${constraintName}`);
    this.name = 'UniqueConstraintError';
    this.constraintName = constraintName;
  }
}

const UNIQUE_CONSTRAINT_PATTERN = /UNIQUE constraint failed:\s*([A-Za-z0-9_.,\s]+)/i;

/**
 * Rethrows a unique-constraint failure as `UniqueConstraintError` and every
 * other failure unchanged. Only the column list is carried over; the rest of
 * the driver message is discarded because it may quote the value.
 */
export function translateDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  const match = UNIQUE_CONSTRAINT_PATTERN.exec(message);
  if (match?.[1]) {
    throw new UniqueConstraintError(match[1].trim());
  }
  throw error instanceof Error ? error : new Error('Database operation failed');
}

/** Runs `operation`, translating constraint violations. */
export async function withTranslatedErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    translateDatabaseError(error);
  }
}
