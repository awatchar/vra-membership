/**
 * Client-side validation.
 *
 * Every message says what to do, not that something is wrong: "กรุณากรอกเลข
 * บัตรประชาชน 13 หลัก" tells the applicant what to type, where "ข้อมูลไม่ถูกต้อง"
 * leaves them guessing (Issue #1 section 68).
 *
 * None of this is a security control. The server validates everything again and
 * is the only thing that decides. This exists so an applicant on a phone finds
 * out about a mistyped digit before they wait for a round trip.
 */

export const CITIZEN_ID_LENGTH = 13;

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Digits only, so a number typed with the dashes on the card still works. */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Formats as `1-2345-67890-12-1` while typing.
 *
 * The grouping on the card is what the applicant is reading from, so matching it
 * lets them check digit by digit instead of counting thirteen in a row.
 */
export function formatCitizenId(value: string): string {
  const digits = digitsOnly(value).slice(0, CITIZEN_ID_LENGTH);
  const groups = [
    digits.slice(0, 1),
    digits.slice(1, 5),
    digits.slice(5, 10),
    digits.slice(10, 12),
    digits.slice(12, 13),
  ];
  return groups.filter((group) => group.length > 0).join('-');
}

/**
 * The mod-11 check digit every Thai national ID carries.
 *
 * Checked here as well as on the server because a mistyped digit is the single
 * most likely error in this form, and catching it in the browser means the
 * applicant fixes it while looking at the card rather than after a submit.
 */
export function isValidCitizenId(value: string): boolean {
  const digits = digitsOnly(value);
  if (digits.length !== CITIZEN_ID_LENGTH) return false;

  let sum = 0;
  for (let index = 0; index < 12; index += 1) {
    sum += Number(digits[index]) * (13 - index);
  }
  return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

export function isValidEmail(value: string): boolean {
  const trimmed = value.trim();
  // Deliberately loose. The server's parser decides; this only catches the
  // obvious "no @ at all" case without rejecting a valid unusual address.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) && trimmed.length <= 200;
}

export function isValidThaiPhone(value: string): boolean {
  const digits = digitsOnly(value);
  return digits.length >= 9 && digits.length <= 10;
}

export function isValidPostcode(value: string): boolean {
  return /^\d{5}$/.test(digitsOnly(value));
}

export function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Built and read back in UTC, comparing the parts. `Date` silently rolls
  // 2026-02-30 forward to 2026-03-02, so only comparing the components catches
  // it - and doing the round trip across two different time zones, as an earlier
  // version of this did, compares two different instants and rejects everything.
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/* ------------------------------------------------------------- per step ---- */

export type IdentityField = 'citizenId' | 'firstName' | 'lastName' | 'birthDate' | 'cardExpiryDate';

export interface IdentityValues {
  citizenId: string;
  title: string;
  firstName: string;
  lastName: string;
  firstNameEn: string;
  lastNameEn: string;
  birthDate: string;
  cardExpiryDate: string;
}

export function validateIdentity(values: IdentityValues): FieldErrors<IdentityField> {
  const errors: FieldErrors<IdentityField> = {};

  const digits = digitsOnly(values.citizenId);
  if (digits.length === 0) {
    errors.citizenId = 'กรุณากรอกเลขบัตรประชาชน 13 หลัก';
  } else if (digits.length !== CITIZEN_ID_LENGTH) {
    errors.citizenId = `กรอกครบ 13 หลัก (ตอนนี้ ${digits.length} หลัก)`;
  } else if (!isValidCitizenId(digits)) {
    errors.citizenId = 'เลขบัตรประชาชนไม่ถูกต้อง กรุณาตรวจทานตัวเลขอีกครั้ง';
  }

  if (values.firstName.trim().length === 0) errors.firstName = 'กรุณากรอกชื่อ';
  if (values.lastName.trim().length === 0) errors.lastName = 'กรุณากรอกนามสกุล';

  if (values.birthDate.length > 0 && !isValidIsoDate(values.birthDate)) {
    errors.birthDate = 'กรุณากรอกวันเกิดในรูปแบบ ปี-เดือน-วัน เช่น 2533-01-15';
  }
  if (values.cardExpiryDate.length > 0 && !isValidIsoDate(values.cardExpiryDate)) {
    errors.cardExpiryDate = 'กรุณากรอกวันหมดอายุบัตรในรูปแบบ ปี-เดือน-วัน';
  }

  return errors;
}

export type ContactField = 'email' | 'phone';

export interface ContactValues {
  email: string;
  phone: string;
  callsign: string;
}

export function validateContact(values: ContactValues): FieldErrors<ContactField> {
  const errors: FieldErrors<ContactField> = {};

  if (values.email.trim().length === 0) {
    // Required, and said so plainly: every document the applicant receives -
    // the receipt included - arrives by email.
    errors.email = 'กรุณากรอกอีเมล ระบบจะส่งใบสำคัญรับเงินและผลการสมัครไปที่อีเมลนี้';
  } else if (!isValidEmail(values.email)) {
    errors.email = 'รูปแบบอีเมลไม่ถูกต้อง เช่น name@example.com';
  }

  if (values.phone.trim().length === 0) {
    errors.phone = 'กรุณากรอกหมายเลขโทรศัพท์';
  } else if (!isValidThaiPhone(values.phone)) {
    errors.phone = 'กรุณากรอกหมายเลขโทรศัพท์ 9-10 หลัก';
  }

  return errors;
}

export type AddressField =
  | 'idAddress'
  | 'idSubdistrict'
  | 'idDistrict'
  | 'idProvince'
  | 'mailAddress'
  | 'mailSubdistrict'
  | 'mailDistrict'
  | 'mailProvince'
  | 'mailPostcode';

export interface AddressValues {
  idAddress: string;
  idSubdistrict: string;
  idDistrict: string;
  idProvince: string;
  mailSameAsId: boolean;
  mailRecipient: string;
  mailAddress: string;
  mailSubdistrict: string;
  mailDistrict: string;
  mailProvince: string;
  mailPostcode: string;
  mailPhone: string;
}

export function validateAddress(values: AddressValues): FieldErrors<AddressField> {
  const errors: FieldErrors<AddressField> = {};

  if (values.idAddress.trim().length === 0) errors.idAddress = 'กรุณากรอกที่อยู่ตามบัตร';
  if (values.idProvince.trim().length === 0) errors.idProvince = 'กรุณากรอกจังหวัดตามบัตร';

  // The postcode is required whether or not the mailing address is the same one.
  // The ID card does not print it, so it can only come from the applicant -
  // copying the address across cannot fill it in (Issue #1 section 9.2).
  if (!isValidPostcode(values.mailPostcode)) {
    errors.mailPostcode = 'กรุณากรอกรหัสไปรษณีย์ 5 หลัก (บัตรประชาชนไม่มีรหัสไปรษณีย์)';
  }

  if (!values.mailSameAsId) {
    if (values.mailAddress.trim().length === 0) {
      errors.mailAddress = 'กรุณากรอกที่อยู่สำหรับจัดส่งเอกสาร';
    }
    if (values.mailProvince.trim().length === 0) {
      errors.mailProvince = 'กรุณากรอกจังหวัดของที่อยู่จัดส่ง';
    }
  }

  return errors;
}

export function hasErrors(errors: Record<string, string | undefined>): boolean {
  return Object.values(errors).some((message) => message !== undefined);
}
