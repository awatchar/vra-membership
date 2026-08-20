import { describe, expect, it } from 'vitest';
import {
  bangkokBuddhistYear,
  bangkokIsoDate,
  formatThaiDate,
  formatThaiDateTime,
  toBangkokParts,
} from '../../src/worker/lib/time';

/** Bangkok is UTC+7 with no daylight saving, which every case below relies on. */

describe('toBangkokParts', () => {
  it('shifts an instant into Bangkok local time', () => {
    expect(toBangkokParts(new Date('2026-08-20T03:04:05.000Z'))).toEqual({
      year: 2026,
      month: 8,
      day: 20,
      hour: 10,
      minute: 4,
      second: 5,
    });
  });

  it('renders Bangkok midnight as hour 0, not hour 24', () => {
    expect(toBangkokParts(new Date('2026-08-19T17:00:00.000Z'))).toMatchObject({
      day: 20,
      hour: 0,
    });
  });

  it('rolls the day over for a late-evening UTC instant', () => {
    expect(toBangkokParts(new Date('2026-08-20T23:30:00.000Z'))).toMatchObject({
      month: 8,
      day: 21,
      hour: 6,
    });
  });
});

describe('bangkokIsoDate', () => {
  it('uses the Bangkok calendar day, not the UTC one', () => {
    expect(bangkokIsoDate(new Date('2026-08-20T23:30:00.000Z'))).toBe('2026-08-21');
    expect(bangkokIsoDate(new Date('2026-08-20T10:00:00.000Z'))).toBe('2026-08-20');
  });
});

describe('bangkokBuddhistYear', () => {
  it('adds 543 to the Gregorian year', () => {
    expect(bangkokBuddhistYear(new Date('2026-08-20T03:00:00.000Z'))).toBe(2569);
  });

  it('is still the old year one second before Bangkok new year', () => {
    // 2026-12-31T16:59:59Z is 2026-12-31T23:59:59 in Bangkok.
    expect(bangkokBuddhistYear(new Date('2026-12-31T16:59:59.000Z'))).toBe(2569);
  });

  it('rolls over at Bangkok midnight, not at UTC midnight', () => {
    // 2026-12-31T17:00:00Z is 2027-01-01T00:00:00 in Bangkok. A number issued at
    // this instant belongs to 2570, even though the UTC year is still 2026.
    expect(bangkokBuddhistYear(new Date('2026-12-31T17:00:00.000Z'))).toBe(2570);
  });

  it('has not rolled over yet at UTC midnight on 1 January', () => {
    // Already 07:00 in Bangkok on 1 January, so the same year as the line above.
    expect(bangkokBuddhistYear(new Date('2027-01-01T00:00:00.000Z'))).toBe(2570);
  });

  it('is never hard-coded to a single year', () => {
    expect(bangkokBuddhistYear(new Date('2030-06-01T00:00:00.000Z'))).toBe(2573);
    expect(bangkokBuddhistYear(new Date('2019-06-01T00:00:00.000Z'))).toBe(2562);
  });
});

describe('Thai display formatting', () => {
  it('renders the date in the Buddhist calendar', () => {
    const formatted = formatThaiDate(new Date('2026-08-20T03:00:00.000Z'));

    expect(formatted).toContain('2569');
    expect(formatted).not.toContain('2026');
  });

  it('renders date and time together in the Buddhist calendar', () => {
    const formatted = formatThaiDateTime(new Date('2026-08-20T03:04:00.000Z'));

    expect(formatted).toContain('2569');
    // 03:04 UTC is 10:04 in Bangkok.
    expect(formatted).toContain('10:04');
  });
});
