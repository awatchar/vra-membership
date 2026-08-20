import type { ImagePayload, OcrProvider, OcrResult, ThaiIdCardData } from '../types';

/**
 * Deterministic OCR stand-in for local development and automated tests.
 *
 * Automated tests must never call iApp (AGENTS.md). The fixture below uses
 * obviously synthetic data that cannot be traced back to a real person.
 */

export const MOCK_ID_CARD: ThaiIdCardData = {
  // Sequential pattern that also satisfies the mod-11 check digit, so it
  // passes validation while being obviously synthetic.
  citizenId: '1234567890121',
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

/**
 * Smallest image the mock will read.
 *
 * The real provider rejects images whose dimensions are too small to hold a
 * card (`INVALID_IMAGE_SIZE`). Mirroring that gives tests a realistic way to
 * exercise the failure path, rather than needing a backdoor in the factory.
 */
const MINIMUM_CARD_IMAGE_BYTES = 64;

export function createMockOcrProvider(options: MockOcrOptions = {}): OcrProvider {
  return {
    name: 'mock-ocr',
    async readThaiIdCardFront(image: ImagePayload): Promise<OcrResult> {
      if (options.failWith) {
        return { ok: false, reason: options.failWith };
      }
      if (image.bytes.byteLength < MINIMUM_CARD_IMAGE_BYTES) {
        return { ok: false, reason: 'PROVIDER_REJECTED_IMAGE' };
      }
      return { ok: true, data: { ...MOCK_ID_CARD, ...options.data } };
    },
  };
}
