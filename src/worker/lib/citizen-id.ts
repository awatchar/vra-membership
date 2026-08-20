/**
 * Thai national ID number handling.
 *
 * Normalisation matters for correctness, not cosmetics: the duplicate-lookup
 * hash is computed from the normalised value, so `1-2345-67890-12-1` and
 * `1234567890121` must reduce to the same string or the same person would be
 * able to apply twice.
 */

/** Digits only, in the order printed on the card. */
export type NormalizedCitizenId = string;

const SEPARATORS = /[\s-]/g;
const THIRTEEN_DIGITS = /^\d{13}$/;

/** Strips spaces and hyphens. Does not validate. */
export function normalizeCitizenId(input: string): NormalizedCitizenId {
  return input.replace(SEPARATORS, '');
}

/**
 * Verifies the mod-11 check digit that every Thai national ID carries.
 * A number that fails this check cannot be a real card number, so rejecting it
 * early keeps unusable values out of the database and out of the OCR review
 * step, where the applicant can still correct a misread digit.
 */
export function isValidCitizenId(input: string): boolean {
  const normalized = normalizeCitizenId(input);
  if (!THIRTEEN_DIGITS.test(normalized)) return false;

  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(normalized[index]) * (13 - index);
  }
  const expected = (11 - (sum % 11)) % 10;
  return expected === Number(normalized[12]);
}
