import { describe, expect, it } from 'vitest';
import { crc16, promptPayPayload, PromptPayError } from '../../src/worker/lib/promptpay';
import { mapSlipOkResponse, slipTransactionInstant } from '../../src/worker/providers/slipok';
import { receiverMatches } from '../../src/worker/services/payment';

/** Synthetic association account. Not a real one. */
const ACCOUNT = {
  accountDigits: '1234567890',
  bankName: 'ธนาคารตัวอย่าง',
  accountName: 'สมาคมนักวิทยุอาสาสมัคร (ตัวอย่าง)',
};

describe('crc16', () => {
  it('is CRC-16/CCITT-FALSE, which is the variant EMVCo requires', () => {
    // The published check value for CRC-16/CCITT-FALSE over "123456789" is
    // 0x29B1. Pinning it distinguishes this variant from its close relatives:
    // XMODEM (init 0x0000) answers 0x31C3 over the same input, and a QR built
    // with the wrong one is rejected by every banking app.
    expect(crc16('123456789')).toBe('29B1');
  });

  it('starts from an all-ones register', () => {
    // Empty input returning FFFF is what distinguishes an init of 0xFFFF from
    // an init of 0x0000.
    expect(crc16('')).toBe('FFFF');
  });

  it('produces four uppercase hex characters', () => {
    expect(crc16('00020101021129370016A00000067701011101130066899999999530376454')).toMatch(
      /^[0-9A-F]{4}$/,
    );
  });
});

describe('promptPayPayload', () => {
  it('encodes a mobile number as 0066 plus the number without its leading zero', () => {
    const payload = promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 50_000);

    // Getting this wrong produces a QR that scans but pays a different account.
    expect(payload).toContain('0066812345678');
  });

  it('writes the exact amount', () => {
    expect(promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 50_000)).toContain(
      '5406500.00',
    );
    expect(promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 200_000)).toContain(
      '54072000.00',
    );
  });

  it('keeps satang exact rather than rounding through a float', () => {
    expect(promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 50_001)).toContain(
      '5406500.01',
    );
  });

  it('marks the QR as dynamic, so it is not reused', () => {
    expect(promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 50_000)).toContain('010212');
  });

  it('ends with a CRC over everything before it', () => {
    const payload = promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 50_000);
    const body = payload.slice(0, -4);

    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toBe(crc16(body));
  });

  it('accepts a national ID and a bank account', () => {
    expect(promptPayPayload({ kind: 'NATIONAL_ID', value: '1234567890121' }, 50_000)).toContain(
      '1234567890121',
    );
    expect(promptPayPayload({ kind: 'BANK_ACCOUNT', value: '1234567890' }, 50_000)).toContain(
      '1234567890',
    );
  });

  it('strips formatting from the target', () => {
    expect(promptPayPayload({ kind: 'PHONE', value: '081-234-5678' }, 50_000)).toContain(
      '0066812345678',
    );
  });

  it('refuses a target of the wrong length rather than producing a bad QR', () => {
    expect(() => promptPayPayload({ kind: 'PHONE', value: '12345' }, 50_000)).toThrow(
      PromptPayError,
    );
    expect(() => promptPayPayload({ kind: 'NATIONAL_ID', value: '123' }, 50_000)).toThrow(
      PromptPayError,
    );
  });

  it('refuses a non-positive or fractional amount', () => {
    expect(() => promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 0)).toThrow(
      PromptPayError,
    );
    expect(() => promptPayPayload({ kind: 'PHONE', value: '0812345678' }, -1)).toThrow(
      PromptPayError,
    );
    expect(() => promptPayPayload({ kind: 'PHONE', value: '0812345678' }, 1.5)).toThrow(
      PromptPayError,
    );
  });
});

describe('receiverMatches', () => {
  it('matches when the visible digits appear in order', () => {
    // Banks mask most of the number; these are the digits left visible.
    expect(receiverMatches('7890', ACCOUNT)).toBe('MATCH');
    expect(receiverMatches('1234567890', ACCOUNT)).toBe('MATCH');
    expect(receiverMatches('1290', ACCOUNT)).toBe('MATCH');
  });

  it('rejects digits that are not in the account', () => {
    expect(receiverMatches('9999', ACCOUNT)).toBe('MISMATCH');
    expect(receiverMatches('7891', ACCOUNT)).toBe('MISMATCH');
  });

  it('rejects digits that are present but out of order', () => {
    // Order matters: otherwise any account made of the same digits would pass.
    expect(receiverMatches('0987', ACCOUNT)).toBe('MISMATCH');
  });

  it('treats too few visible digits as unverifiable, not as a match', () => {
    // Approving a payment without knowing where the money went is the wrong
    // way to fail on a payment path.
    expect(receiverMatches('12', ACCOUNT)).toBe('UNVERIFIABLE');
    expect(receiverMatches('', ACCOUNT)).toBe('UNVERIFIABLE');
    expect(receiverMatches(null, ACCOUNT)).toBe('UNVERIFIABLE');
  });

  it('treats an unusable configured account as unverifiable', () => {
    expect(receiverMatches('1234', { ...ACCOUNT, accountDigits: '12' })).toBe('UNVERIFIABLE');
    expect(receiverMatches('1234', { ...ACCOUNT, accountDigits: '' })).toBe('UNVERIFIABLE');
  });
});

describe('slipTransactionInstant', () => {
  it('prefers the ISO timestamp when present', () => {
    expect(slipTransactionInstant({ transTimestamp: '2026-08-20T10:04:05+07:00' })).toBe(
      '2026-08-20T03:04:05.000Z',
    );
  });

  it('falls back to the date and time fields as Bangkok local time', () => {
    // Treating these as UTC would put the transfer seven hours earlier, which
    // near midnight lands it on the wrong day.
    expect(slipTransactionInstant({ transDate: '20260820', transTime: '10:04:05' })).toBe(
      '2026-08-20T03:04:05.000Z',
    );
  });

  it('defaults the time to midnight Bangkok when only a date is given', () => {
    expect(slipTransactionInstant({ transDate: '20260820' })).toBe('2026-08-19T17:00:00.000Z');
  });

  it('returns null when nothing usable is present', () => {
    expect(slipTransactionInstant({})).toBeNull();
    expect(slipTransactionInstant({ transDate: 'not-a-date' })).toBeNull();
    expect(slipTransactionInstant({ transTimestamp: 'nonsense' })).toBeNull();
  });
});

describe('mapSlipOkResponse', () => {
  const RESPONSE = {
    success: true,
    data: {
      success: true,
      message: 'ตรวจสอบสำเร็จ',
      language: 'TH',
      transRef: 'TXN0000000000001',
      transDate: '20260820',
      transTime: '10:04:05',
      transTimestamp: '2026-08-20T10:04:05+07:00',
      amount: 500,
      sendingBank: '002',
      receivingBank: '004',
      sender: {
        displayName: 'นาย ทดสอบ ระบบสมัคร',
        name: 'MR THODSOB',
        account: { type: 'BANKAC', value: 'xxx-x-x9876-x' },
      },
      receiver: {
        displayName: 'สมาคมนักวิทยุอาสาสมัคร',
        name: 'VRA',
        account: { type: 'BANKAC', value: 'xxx-x-x7890-x' },
      },
      ref1: 'REF1',
      countryCode: 'TH',
    },
  };

  it('maps the fields the payment path needs', () => {
    expect(mapSlipOkResponse(RESPONSE)).toEqual({
      transactionRef: 'TXN0000000000001',
      amount: 50_000,
      sendingBank: '002',
      receivingBank: '004',
      receiverAccountDigits: '7890',
      receiverName: 'สมาคมนักวิทยุอาสาสมัคร',
      transactionAt: '2026-08-20T03:04:05.000Z',
    });
  });

  it('converts the amount to satang', () => {
    expect(
      mapSlipOkResponse({ ...RESPONSE, data: { ...RESPONSE.data, amount: 2000 } })?.amount,
    ).toBe(200_000);
    expect(
      mapSlipOkResponse({ ...RESPONSE, data: { ...RESPONSE.data, amount: 500.5 } })?.amount,
    ).toBe(50_050);
  });

  it('rounds a decimal that cannot be represented exactly', () => {
    // 499.999999 must not end up looking different from 500.00 by a fraction
    // of a satang once it reaches an integer comparison.
    expect(
      mapSlipOkResponse({ ...RESPONSE, data: { ...RESPONSE.data, amount: 499.999999 } })?.amount,
    ).toBe(50_000);
  });

  it('drops the sender entirely', () => {
    const serialised = JSON.stringify(mapSlipOkResponse(RESPONSE));

    // Who paid is already known from the application; the payer's masked
    // account number has no reason to be stored.
    expect(serialised).not.toContain('9876');
    expect(serialised).not.toContain('THODSOB');
  });

  it('drops provider extras', () => {
    const serialised = JSON.stringify(mapSlipOkResponse(RESPONSE));

    expect(serialised).not.toContain('REF1');
    expect(serialised).not.toContain('language');
    expect(serialised).not.toContain('countryCode');
  });

  it('returns null when the provider says the slip is not valid', () => {
    expect(
      mapSlipOkResponse({ ...RESPONSE, data: { ...RESPONSE.data, success: false } }),
    ).toBeNull();
  });

  it('returns null without a transaction reference or a usable amount', () => {
    expect(mapSlipOkResponse({ ...RESPONSE, data: { ...RESPONSE.data, transRef: '' } })).toBeNull();
    expect(mapSlipOkResponse({ ...RESPONSE, data: { ...RESPONSE.data, amount: 0 } })).toBeNull();
    expect(mapSlipOkResponse({})).toBeNull();
    expect(mapSlipOkResponse(null)).toBeNull();
  });

  it('tolerates a missing receiver account', () => {
    const mapped = mapSlipOkResponse({
      ...RESPONSE,
      data: { ...RESPONSE.data, receiver: { displayName: 'สมาคม' } },
    });

    // Null here becomes UNVERIFIABLE at the check, not a silent pass.
    expect(mapped?.receiverAccountDigits).toBeNull();
  });
});
