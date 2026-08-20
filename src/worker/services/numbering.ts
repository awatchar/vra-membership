import { UniqueConstraintError } from '../db';
import type { Repository } from '../db';
import { bangkokBuddhistYear } from '../lib/time';

/**
 * Application and receipt numbering (Issue #1 sections 24, 29, 70).
 *
 * Numbers look like `VRA-2569-000001` and `VRA-RC-2569-000091`: a configurable
 * prefix, the Buddhist-era year derived from Bangkok local time, and a running
 * sequence that restarts each year.
 *
 * Uniqueness is a database guarantee, not an application one. The sequence is
 * proposed by reading the highest number already issued for the year, and the
 * `UNIQUE` constraint decides whether the proposal wins. A loser retries with
 * the next value. Reading a maximum and adding one without that guard is the
 * classic way to hand two applicants the same receipt number.
 */

export interface NumberFormat {
  /** Uppercase letters, digits and hyphens only. */
  prefix: string;
  /** Zero-padded width of the running sequence. */
  sequenceLength: number;
}

export const DEFAULT_APPLICATION_FORMAT: NumberFormat = { prefix: 'VRA', sequenceLength: 6 };
export const DEFAULT_RECEIPT_FORMAT: NumberFormat = { prefix: 'VRA-RC', sequenceLength: 6 };

/** Attempts before giving up, so a pathological race cannot spin forever. */
const MAX_ATTEMPTS = 10;

const PREFIX_PATTERN = /^[A-Z][A-Z0-9-]*$/;

export class NumberingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NumberingError';
  }
}

function assertValidFormat(format: NumberFormat): void {
  // The prefix reaches SQL as part of a bound `like` pattern, so `%` and `_`
  // must be impossible. Restricting the character set is the guard.
  if (!PREFIX_PATTERN.test(format.prefix)) {
    throw new NumberingError('Number prefix must contain only A-Z, 0-9 and hyphens');
  }
  if (!Number.isInteger(format.sequenceLength) || format.sequenceLength < 1) {
    throw new NumberingError('Number sequence length must be a positive integer');
  }
}

export function formatNumber(format: NumberFormat, year: number, sequence: number): string {
  return `${format.prefix}-${year}-${String(sequence).padStart(format.sequenceLength, '0')}`;
}

/** `VRA-2569-%`, used to find the highest number issued for a year. */
function yearPattern(format: NumberFormat, year: number): string {
  return `${format.prefix}-${year}-%`;
}

/**
 * Reads the sequence out of a number. Returns 0 when the value does not match
 * the current format, so a stored number from an older format cannot make the
 * next sequence go backwards or produce `NaN`.
 */
export function parseSequence(format: NumberFormat, value: string | null, year: number): number {
  if (value === null) return 0;
  const expectedStart = `${format.prefix}-${year}-`;
  if (!value.startsWith(expectedStart)) return 0;
  const sequence = Number(value.slice(expectedStart.length));
  return Number.isInteger(sequence) && sequence > 0 ? sequence : 0;
}

export interface NumberingOptions {
  applicationFormat?: NumberFormat;
  receiptFormat?: NumberFormat;
  now?: () => Date;
}

export interface NumberingService {
  /**
   * Assigns the application number and returns it. Returns the existing number
   * unchanged when the application already has one, so a retried request cannot
   * issue a second number for the same application.
   */
  assignApplicationNumber(applicationId: string): Promise<string>;
  /**
   * Runs `insert` with successive candidate receipt numbers until it succeeds.
   * `insert` must be a single atomic write, because a candidate that loses the
   * race must leave nothing behind.
   */
  issueReceiptNumber<T>(insert: (receiptNo: string) => Promise<T>): Promise<T>;
}

export function createNumberingService(
  db: Repository,
  options: NumberingOptions = {},
): NumberingService {
  const applicationFormat = options.applicationFormat ?? DEFAULT_APPLICATION_FORMAT;
  const receiptFormat = options.receiptFormat ?? DEFAULT_RECEIPT_FORMAT;
  const now = options.now ?? (() => new Date());

  assertValidFormat(applicationFormat);
  assertValidFormat(receiptFormat);

  return {
    async assignApplicationNumber(applicationId) {
      const existing = await db.applications.findById(applicationId);
      if (!existing) {
        throw new NumberingError('Application does not exist');
      }
      if (existing.referenceNo !== null) {
        return existing.referenceNo;
      }

      const year = bangkokBuddhistYear(now());

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        // Always the highest issued number plus one, re-read on every attempt.
        // Offsetting by the attempt counter instead would avoid a second
        // collision but leave gaps in the sequence, and a missing number in a
        // run of receipts is the kind of thing an auditor asks about.
        const highest = await db.applications.findMaxReferenceNo(
          yearPattern(applicationFormat, year),
        );
        const candidate = formatNumber(
          applicationFormat,
          year,
          parseSequence(applicationFormat, highest, year) + 1,
        );

        try {
          await db.applications.setReferenceNo(applicationId, candidate);
          return candidate;
        } catch (error) {
          if (!(error instanceof UniqueConstraintError)) throw error;

          // Either the candidate was taken by a concurrent request, or this
          // application was given a number in the meantime. Re-read to tell the
          // two apart: issuing a second number to one application would put two
          // different references on documents the applicant has already seen.
          const current = await db.applications.findById(applicationId);
          if (current?.referenceNo) {
            return current.referenceNo;
          }
        }
      }

      throw new NumberingError('Could not allocate an application number');
    },

    async issueReceiptNumber(insert) {
      const year = bangkokBuddhistYear(now());

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        // See `assignApplicationNumber`: always highest + 1, so the receipt
        // sequence has no gaps.
        const highest = await db.receipts.findMaxReceiptNo(yearPattern(receiptFormat, year));
        const candidate = formatNumber(
          receiptFormat,
          year,
          parseSequence(receiptFormat, highest, year) + 1,
        );

        try {
          return await insert(candidate);
        } catch (error) {
          if (!(error instanceof UniqueConstraintError)) throw error;
          // A constraint other than the receipt number means retrying with a
          // new number will fail the same way, so stop instead of looping.
          if (!error.constraintName.includes('receipt_no')) throw error;
        }
      }

      throw new NumberingError('Could not allocate a receipt number');
    },
  };
}
