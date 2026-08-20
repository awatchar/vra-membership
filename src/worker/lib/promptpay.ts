/**
 * Thai QR Payment (PromptPay) payload generation.
 *
 * Issue #1 section 16 asks for a QR carrying the exact amount, so the applicant
 * cannot transfer the wrong total by mistake - which is the single most common
 * cause of a payment that then has to be refunded by hand.
 *
 * The payload is an EMVCo QR string. This module builds the string only; the
 * browser renders it. Generating an image server-side would mean shipping a
 * rasteriser for no benefit.
 *
 * The amount in the QR is authoritative for the transfer, but it is not what
 * verification trusts: the expected amount is resolved from the membership type
 * on the server and re-checked against the slip.
 */

/** EMVCo field identifiers used here. */
const ID_PAYLOAD_FORMAT = '00';
const ID_POINT_OF_INITIATION = '01';
const ID_MERCHANT_PROMPTPAY = '29';
const ID_COUNTRY = '58';
const ID_CURRENCY = '53';
const ID_AMOUNT = '54';
const ID_CRC = '63';

/** Sub-fields inside the PromptPay merchant template. */
const SUB_AID = '00';
const SUB_PHONE = '01';
const SUB_NATIONAL_ID = '02';
const SUB_EWALLET = '03';
const SUB_BANK_ACCOUNT = '04';

const PROMPTPAY_AID = 'A000000677010111';
const CURRENCY_THB = '764';
const COUNTRY_TH = 'TH';

/** One-time QR: the amount is fixed, so it must not be reused. */
const DYNAMIC_QR = '12';

export type PromptPayTargetKind = 'PHONE' | 'NATIONAL_ID' | 'EWALLET' | 'BANK_ACCOUNT';

export interface PromptPayTarget {
  kind: PromptPayTargetKind;
  /** Digits only; formatting is stripped by `promptPayPayload`. */
  value: string;
}

export class PromptPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptPayError';
  }
}

function field(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE over the payload including the CRC field's own tag and
 * length, which is what the EMVCo specification requires.
 */
export function crc16(input: string): string {
  let crc = 0xffff;

  for (let index = 0; index < input.length; index += 1) {
    crc ^= input.charCodeAt(index) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Normalises a PromptPay target to the form the payload expects.
 *
 * A Thai mobile number is carried as 13 digits: `0066` plus the number without
 * its leading zero. Getting this wrong produces a QR that scans but pays the
 * wrong account, which is why it is done here once rather than at each caller.
 */
function normalizeTarget(target: PromptPayTarget): { subId: string; value: string } {
  const digits = target.value.replace(/\D/g, '');

  switch (target.kind) {
    case 'PHONE': {
      if (digits.length !== 10 || !digits.startsWith('0')) {
        throw new PromptPayError('PromptPay phone target must be 10 digits starting with 0');
      }
      return { subId: SUB_PHONE, value: `0066${digits.slice(1)}` };
    }
    case 'NATIONAL_ID': {
      if (digits.length !== 13) {
        throw new PromptPayError('PromptPay national ID target must be 13 digits');
      }
      return { subId: SUB_NATIONAL_ID, value: digits };
    }
    case 'EWALLET': {
      if (digits.length !== 15) {
        throw new PromptPayError('PromptPay e-wallet target must be 15 digits');
      }
      return { subId: SUB_EWALLET, value: digits };
    }
    case 'BANK_ACCOUNT': {
      if (digits.length < 10 || digits.length > 43) {
        throw new PromptPayError('PromptPay bank account target has an implausible length');
      }
      return { subId: SUB_BANK_ACCOUNT, value: digits };
    }
  }
}

/**
 * Builds a dynamic PromptPay payload for an exact amount.
 *
 * `amountSatang` is an integer, so the baht value written into the QR is exact
 * rather than the result of a floating-point division that happened to round
 * the right way.
 */
export function promptPayPayload(target: PromptPayTarget, amountSatang: number): string {
  if (!Number.isInteger(amountSatang) || amountSatang <= 0) {
    throw new PromptPayError('PromptPay amount must be a positive whole number of satang');
  }

  const { subId, value } = normalizeTarget(target);
  const baht = Math.trunc(amountSatang / 100);
  const satang = amountSatang % 100;
  const amount = `${baht}.${String(satang).padStart(2, '0')}`;

  const merchant = field(SUB_AID, PROMPTPAY_AID) + field(subId, value);

  const withoutCrc =
    field(ID_PAYLOAD_FORMAT, '01') +
    field(ID_POINT_OF_INITIATION, DYNAMIC_QR) +
    field(ID_MERCHANT_PROMPTPAY, merchant) +
    field(ID_COUNTRY, COUNTRY_TH) +
    field(ID_CURRENCY, CURRENCY_THB) +
    field(ID_AMOUNT, amount) +
    `${ID_CRC}04`;

  return withoutCrc + crc16(withoutCrc);
}
