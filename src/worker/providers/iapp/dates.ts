/**
 * Date parsing for iApp OCR output.
 *
 * iApp returns each date twice: `th_dob` in the Buddhist calendar with a Thai
 * month abbreviation ("26 ก.ค. 2559") and `en_dob` in the Gregorian calendar
 * with an English one ("26 Jul 2016"). The English form is parsed because the
 * database stores Gregorian ISO dates, so using it avoids a calendar
 * conversion that could be off by a year around the new year.
 *
 * A value that does not parse becomes null rather than an error. OCR output is
 * a pre-fill that the applicant reviews and corrects (Issue #1 section 7), so an
 * unreadable date should leave the field empty, not reject the whole card.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/** `D MMM YYYY` in English, e.g. `26 Jul 2016`. */
const EN_DATE_PATTERN = /^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/;

/**
 * Converts an iApp English date to `YYYY-MM-DD`, or null when it is missing,
 * masked or otherwise unparseable.
 */
export function parseIappEnglishDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const match = EN_DATE_PATTERN.exec(value.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2]!.slice(0, 3).toLowerCase()];
  const year = Number(match[3]);

  if (month === undefined || day < 1 || day > 31) return null;

  // Reject a date that does not exist, such as 31 February: the applicant would
  // otherwise see a silently shifted value and might not notice.
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0',
  )}`;
}
