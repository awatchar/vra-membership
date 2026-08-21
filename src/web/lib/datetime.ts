/**
 * Dates and times, always in Bangkok and always in the Buddhist era.
 *
 * The manager reads these next to documents that print `2569`, and the applicant
 * gave a birth date from a card printed the same way. Rendering an ISO instant in
 * the browser's own zone would show a different day either side of midnight, and
 * a Gregorian year would not match anything else the association handles
 * (Issue #1 section 69).
 *
 * `th-TH-u-ca-buddhist` fixes the calendar explicitly rather than relying on
 * `th-TH` defaulting to it, which is true in current ICU but is not a guarantee.
 */

const TIME_ZONE = 'Asia/Bangkok';
const LOCALE = 'th-TH-u-ca-buddhist';

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function parse(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** An instant as a Bangkok date, or a dash when there is none. */
export function formatDate(value: string | null | undefined): string {
  const parsed = parse(value);
  return parsed ? dateFormatter.format(parsed) : '—';
}

/**
 * An instant as a Bangkok date and time, or a dash when there is none.
 *
 * The formatter's own output already reads `20 สิงหาคม 2569 เวลา 09:30`, so
 * nothing is appended - adding `น.` after the locale's `เวลา` reads wrong.
 */
export function formatDateTime(value: string | null | undefined): string {
  const parsed = parse(value);
  return parsed ? dateTimeFormatter.format(parsed) : '—';
}

/**
 * A stored `YYYY-MM-DD`, which is a Bangkok calendar date rather than an
 * instant.
 *
 * Parsed with the offset written in, because `new Date('1990-01-15')` is
 * midnight UTC - which is the previous evening in Bangkok, and would show the
 * wrong day for every birth date in the database.
 */
export function formatCalendarDate(value: string | null | undefined): string {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00+07:00`);
  return Number.isNaN(parsed.getTime()) ? '—' : dateFormatter.format(parsed);
}
