import type { ImagePayload, OcrProvider, OcrResult, ThaiIdCardData } from '../types';

/**
 * Deterministic OCR stand-in for local development and automated tests.
 *
 * Automated tests must never call iApp (AGENTS.md). The fixture below uses
 * obviously synthetic data that cannot be traced back to a real person.
 */

export const MOCK_ID_CARD: ThaiIdCardData = {
  citizenId: '1234567890123',
  titleTh: 'นาย',
  firstNameTh: 'ทดสอบ',
  lastNameTh: 'ระบบสมัคร',
  firstNameEn: 'Thodsob',
  lastNameEn: 'Rabobsamak',
  birthDate: '1990-01-15',
  cardExpiryDate: '2032-01-14',
  addressLine: '999 หมู่ 9',
  subdistrict: 'ตัวอย่าง',
  district: 'ตัวอย่าง',
  province: 'กรุงเทพมหานคร',
  faceImage: null,
};

export interface MockOcrOptions {
  /** Overrides the successful result. */
  data?: Partial<ThaiIdCardData>;
  /** When set, every call fails with this reason. */
  failWith?: Extract<OcrResult, { ok: false }>['reason'];
}

export function createMockOcrProvider(options: MockOcrOptions = {}): OcrProvider {
  return {
    name: 'mock-ocr',
    async readThaiIdCardFront(image: ImagePayload): Promise<OcrResult> {
      if (options.failWith) {
        return { ok: false, reason: options.failWith };
      }
      if (image.bytes.byteLength === 0) {
        return { ok: false, reason: 'PROVIDER_REJECTED_IMAGE' };
      }
      return { ok: true, data: { ...MOCK_ID_CARD, ...options.data } };
    },
  };
}
