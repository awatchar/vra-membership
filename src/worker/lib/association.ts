/**
 * Facts about the association that appear in documents and email.
 *
 * Kept in one place because the same strings are printed on the receipt and sent
 * in every email, and two copies would eventually disagree with each other in
 * front of a member.
 */

export const ASSOCIATION_NAME = 'สมาคมนักวิทยุอาสาสมัคร';

/**
 * Where a member can confirm their own registration with the regulator.
 * Linked from the completion email (Issue #1 section 40) so the member can
 * verify the association's claim rather than having to take its word.
 */
export const NBTC_PUBLIC_SERVICE_URL = 'https://oss.nbtc.go.th/OSS2/Home/';
