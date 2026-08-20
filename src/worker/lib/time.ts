/**
 * Time handling.
 *
 * The database stores ISO 8601 UTC instants. Everything an applicant or the
 * association manager sees is expressed in Asia/Bangkok, and every generated
 * number carries a Buddhist-era year derived from Bangkok local time
 * (Issue #1 sections 69 and 70).
 *
 * The offset is never hard-coded and the year is never taken from the UTC date:
 * an application submitted at 23:30 UTC belongs to the next Bangkok day, and on
 * 31 December that also means the next Buddhist year.
 */

export const BANGKOK_TIME_ZONE = 'Asia/Bangkok';

/** Difference between the Buddhist and Gregorian calendar years. */
const BUDDHIST_ERA_OFFSET = 543;

export interface BangkokDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BANGKOK_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  // `h23` rather than `hour12: false`, which renders midnight as hour 24 in
  // some ICU versions.
  hourCycle: 'h23',
});

type NumericPart = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second';

/** Gregorian calendar parts of `instant` as seen in Bangkok. */
export function toBangkokParts(instant: Date): BangkokDateParts {
  const values = new Map<string, string>(
    partsFormatter.formatToParts(instant).map((part) => [part.type, part.value]),
  );

  const read = (type: NumericPart): number => {
    const value = values.get(type);
    if (value === undefined) {
      throw new Error(`Bangkok date part is missing: ${type}`);
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
      throw new Error(`Bangkok date part is not numeric: ${type}`);
    }
    return parsed;
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Buddhist-era year of `instant` in Bangkok, e.g. 2569 for 2026. */
export function bangkokBuddhistYear(instant: Date): number {
  return toBangkokParts(instant).year + BUDDHIST_ERA_OFFSET;
}

/** `YYYY-MM-DD` of `instant` in Bangkok, Gregorian. */
export function bangkokIsoDate(instant: Date): string {
  const { year, month, day } = toBangkokParts(instant);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(
    2,
    '0',
  )}`;
}

const thaiDateFormatter = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
  timeZone: BANGKOK_TIME_ZONE,
  dateStyle: 'long',
});

const thaiDateTimeFormatter = new Intl.DateTimeFormat('th-TH-u-ca-buddhist', {
  timeZone: BANGKOK_TIME_ZONE,
  dateStyle: 'long',
  timeStyle: 'short',
});

/** Thai display date in the Buddhist calendar, e.g. for a receipt. */
export function formatThaiDate(instant: Date): string {
  return thaiDateFormatter.format(instant);
}

/** Thai display date and time in the Buddhist calendar. */
export function formatThaiDateTime(instant: Date): string {
  return thaiDateTimeFormatter.format(instant);
}
