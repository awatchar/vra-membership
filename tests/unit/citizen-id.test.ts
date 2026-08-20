import { describe, expect, it } from 'vitest';
import { isValidCitizenId, normalizeCitizenId } from '../../src/worker/lib/citizen-id';

/**
 * Every number below is synthetic. `1234567890121` is a sequential pattern that
 * happens to satisfy the check digit, so it cannot be mistaken for a real card.
 */
const VALID = '1234567890121';

describe('normalizeCitizenId', () => {
  it('strips the separators printed on the card', () => {
    expect(normalizeCitizenId('1-2345-67890-12-1')).toBe(VALID);
  });

  it('strips whitespace', () => {
    expect(normalizeCitizenId(' 1 2345 67890 12 1 ')).toBe(VALID);
  });

  it('leaves an already normalised value untouched', () => {
    expect(normalizeCitizenId(VALID)).toBe(VALID);
  });

  it('produces the same value for every separator style, so the hash matches', () => {
    const forms = [VALID, '1-2345-67890-12-1', '1 2345 67890 12 1', '1-234567890 12-1'];
    expect(new Set(forms.map(normalizeCitizenId)).size).toBe(1);
  });
});

describe('isValidCitizenId', () => {
  it('accepts a number with a correct check digit', () => {
    expect(isValidCitizenId(VALID)).toBe(true);
  });

  it('accepts a formatted number with a correct check digit', () => {
    expect(isValidCitizenId('1-2345-67890-12-1')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidCitizenId('1234567890123')).toBe(false);
  });

  it('rejects a transposition that keeps the same digits', () => {
    expect(isValidCitizenId('2134567890121')).toBe(false);
  });

  it('rejects the wrong length', () => {
    expect(isValidCitizenId('123456789012')).toBe(false);
    expect(isValidCitizenId('12345678901211')).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(isValidCitizenId('12345678901aa')).toBe(false);
    expect(isValidCitizenId('')).toBe(false);
  });

  it('handles a check digit that wraps from 10 to 0', () => {
    // Constructed so that (11 - (sum % 11)) % 10 === 0.
    const candidates = Array.from({ length: 10 }, (_, digit) => `111111111111${digit}`);
    const accepted = candidates.filter(isValidCitizenId);
    expect(accepted).toHaveLength(1);
  });
});
