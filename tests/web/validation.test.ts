import { describe, expect, it } from 'vitest';
import {
  digitsOnly,
  formatCitizenId,
  hasErrors,
  isValidCitizenId,
  isValidEmail,
  isValidIsoDate,
  isValidPostcode,
  isValidThaiPhone,
  validateAddress,
  validateContact,
  validateIdentity,
} from '../../src/web/state/validation';
import { EMPTY_ADDRESS, EMPTY_CONTACT, EMPTY_IDENTITY } from '../../src/web/state/wizard';

/** Synthetic, and a valid check digit: 1234567890121. */
const VALID_ID = '1234567890121';

describe('citizen ID', () => {
  it('accepts a number with a correct check digit', () => {
    expect(isValidCitizenId(VALID_ID)).toBe(true);
  });

  it('rejects a single mistyped digit', () => {
    // The most likely error in the whole form, which is why it is checked in the
    // browser and not only on the server.
    expect(isValidCitizenId('1234567890122')).toBe(false);
  });

  it('accepts the number typed with the dashes printed on the card', () => {
    expect(isValidCitizenId('1-2345-67890-12-1')).toBe(true);
    expect(digitsOnly('1-2345-67890-12-1')).toBe(VALID_ID);
  });

  it('formats into the groups printed on the card as it is typed', () => {
    expect(formatCitizenId('1')).toBe('1');
    expect(formatCitizenId('12345')).toBe('1-2345');
    expect(formatCitizenId('1234567890')).toBe('1-2345-67890');
    expect(formatCitizenId(VALID_ID)).toBe('1-2345-67890-12-1');
  });

  it('ignores anything typed past thirteen digits', () => {
    expect(formatCitizenId('12345678901219999')).toBe('1-2345-67890-12-1');
  });

  it('rejects a number that is too short', () => {
    expect(isValidCitizenId('123')).toBe(false);
  });
});

describe('other fields', () => {
  it('accepts a plausible email and rejects one with no domain', () => {
    expect(isValidEmail('member@example.test')).toBe(true);
    expect(isValidEmail('member@example')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
  });

  it('accepts Thai phone numbers of nine or ten digits', () => {
    expect(isValidThaiPhone('0812345678')).toBe(true);
    expect(isValidThaiPhone('021234567')).toBe(true);
    expect(isValidThaiPhone('0812')).toBe(false);
  });

  it('accepts a five-digit postcode, with or without spacing', () => {
    expect(isValidPostcode('10200')).toBe(true);
    expect(isValidPostcode('102 00')).toBe(true);
    expect(isValidPostcode('1020')).toBe(false);
  });

  it('rejects a date that looks well formed but does not exist', () => {
    expect(isValidIsoDate('1990-01-15')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('15/01/1990')).toBe(false);
  });
});

describe('the identity step', () => {
  it('asks for what is missing, one message per field', () => {
    const errors = validateIdentity(EMPTY_IDENTITY);

    expect(errors.citizenId).toContain('13 หลัก');
    expect(errors.firstName).toBe('กรุณากรอกชื่อ');
    expect(errors.lastName).toBe('กรุณากรอกนามสกุล');
  });

  it('says how many digits have been typed so far', () => {
    // "Invalid" would leave the applicant counting; the count tells them where
    // they are.
    const errors = validateIdentity({ ...EMPTY_IDENTITY, citizenId: '12345' });

    expect(errors.citizenId).toContain('5 หลัก');
  });

  it('passes a complete, valid identity', () => {
    const errors = validateIdentity({
      ...EMPTY_IDENTITY,
      citizenId: VALID_ID,
      firstName: 'ทดสอบ',
      lastName: 'ระบบสมัคร',
      birthDate: '1990-01-15',
    });

    expect(hasErrors(errors)).toBe(false);
  });

  it('treats the dates as optional but checks them when present', () => {
    const base = { ...EMPTY_IDENTITY, citizenId: VALID_ID, firstName: 'ก', lastName: 'ข' };

    expect(hasErrors(validateIdentity(base))).toBe(false);
    expect(validateIdentity({ ...base, birthDate: '1990-13-45' }).birthDate).toBeDefined();
  });
});

describe('the contact step', () => {
  it('explains why the email is required', () => {
    const errors = validateContact(EMPTY_CONTACT);

    // A wrong or missing address means the applicant pays and hears nothing, so
    // the message says what the address is for.
    expect(errors.email).toContain('ใบสำคัญรับเงิน');
    expect(errors.phone).toBeDefined();
  });

  it('treats the callsign as optional', () => {
    const errors = validateContact({
      email: 'member@example.test',
      phone: '0812345678',
      callsign: '',
    });

    expect(hasErrors(errors)).toBe(false);
  });
});

describe('the address step', () => {
  it('requires the postcode even when the mailing address is the same', () => {
    // The card does not print one, so copying the address across cannot supply
    // it (Issue #1 section 9.2).
    const errors = validateAddress({
      ...EMPTY_ADDRESS,
      idAddress: '99/9',
      idProvince: 'กรุงเทพมหานคร',
      mailSameAsId: true,
      mailPostcode: '',
    });

    expect(errors.mailPostcode).toContain('บัตรประชาชนไม่มีรหัสไปรษณีย์');
  });

  it('passes with the card address and a postcode', () => {
    const errors = validateAddress({
      ...EMPTY_ADDRESS,
      idAddress: '99/9',
      idProvince: 'กรุงเทพมหานคร',
      mailSameAsId: true,
      mailPostcode: '10200',
    });

    expect(hasErrors(errors)).toBe(false);
  });

  it('asks for the mailing address only when it differs', () => {
    const separate = validateAddress({
      ...EMPTY_ADDRESS,
      idAddress: '99/9',
      idProvince: 'กรุงเทพมหานคร',
      mailSameAsId: false,
      mailPostcode: '10200',
    });

    expect(separate.mailAddress).toBeDefined();
    expect(separate.mailProvince).toBeDefined();
  });
});
