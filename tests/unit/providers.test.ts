import { describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/worker/env';
import type { WorkerEnv } from '../../src/worker/env';
import { ProviderNotConfiguredError, createProviders } from '../../src/worker/providers';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import { createMockOcrProvider } from '../../src/worker/providers/mock/ocr';
import { createMockSlipProvider } from '../../src/worker/providers/mock/slip';

function fakeEnv(providerMode: 'mock' | 'live', secrets: Record<string, string> = {}): WorkerEnv {
  return { PROVIDER_MODE: providerMode, ...secrets } as unknown as WorkerEnv;
}

const OCR_FIELDS = [
  'addressLine',
  'birthDate',
  'cardExpiryDate',
  'citizenId',
  'district',
  'faceImage',
  'firstNameEn',
  'firstNameTh',
  'lastNameEn',
  'lastNameTh',
  'province',
  'subdistrict',
  'titleTh',
];

describe('createProviders', () => {
  it('returns mock adapters in mock mode', () => {
    const providers = createProviders(fakeEnv('mock'));

    expect(providers.ocr.name).toBe('mock-ocr');
    expect(providers.slip.name).toBe('mock-slip');
    expect(providers.email.name).toBe('mock-email');
  });

  it('never falls back to mocks in live mode', () => {
    const providers = createProviders(fakeEnv('live'));

    // A silent fallback to mocks in production would be far worse than an
    // error, so every accessor must throw when it cannot be built for real.
    expect(() => providers.ocr).toThrow();
    expect(() => providers.slip).toThrow();
    expect(() => providers.email).toThrow();
  });

  it('reports a missing secret rather than a missing adapter for OCR', () => {
    // The iApp adapter exists, so the only thing standing in the way is the
    // secret, and the error should say which one.
    const providers = createProviders(fakeEnv('live'));

    expect(() => providers.ocr).toThrow(ConfigurationError);
    expect(() => providers.ocr).toThrow(/IAPP_API_KEY/);
  });

  it('builds the live OCR adapter once the secret is present', () => {
    const providers = createProviders(fakeEnv('live', { IAPP_API_KEY: 'test-only-key' }));

    expect(providers.ocr.name).toBe('iapp-ocr');
  });

  it('still reports slip and email as not implemented', () => {
    const providers = createProviders(fakeEnv('live', { IAPP_API_KEY: 'test-only-key' }));

    expect(() => providers.slip).toThrow(ProviderNotConfiguredError);
    expect(() => providers.email).toThrow(ProviderNotConfiguredError);
  });
});

/** Large enough that the mock treats it as a readable card image. */
function cardSizedImage(): Uint8Array {
  return new Uint8Array(128).fill(1);
}

describe('mock OCR provider', () => {
  it('returns only the fields the membership process needs', async () => {
    const result = await createMockOcrProvider().readThaiIdCardFront({
      bytes: cardSizedImage(),
      contentType: 'image/jpeg',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.data).sort()).toEqual([...OCR_FIELDS].sort());
  });

  it('rejects an empty image', async () => {
    const result = await createMockOcrProvider().readThaiIdCardFront({
      bytes: new Uint8Array(),
      contentType: 'image/jpeg',
    });

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_REJECTED_IMAGE' });
  });

  it('rejects an image too small to be a card, as the real provider does', async () => {
    // The real API answers INVALID_IMAGE_SIZE for an image whose dimensions
    // cannot hold a card, and mirroring that gives route tests a realistic way
    // to reach the OCR failure path.
    const result = await createMockOcrProvider().readThaiIdCardFront({
      bytes: new Uint8Array(10).fill(1),
      contentType: 'image/jpeg',
    });

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_REJECTED_IMAGE' });
  });

  it('can be configured to fail', async () => {
    const provider = createMockOcrProvider({ failWith: 'PROVIDER_TIMEOUT' });
    const result = await provider.readThaiIdCardFront({
      bytes: cardSizedImage(),
      contentType: 'image/jpeg',
    });

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_TIMEOUT' });
  });
});

describe('mock slip provider', () => {
  it('mirrors the server-resolved expected amount by default', async () => {
    const result = await createMockSlipProvider().verify({
      evidence: { kind: 'qr', payload: 'mock-qr' },
      expectedAmount: 2000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.amount).toBe(2000);
  });

  it('can simulate a duplicate slip', async () => {
    const result = await createMockSlipProvider({ failWith: 'DUPLICATE_SLIP' }).verify({
      evidence: { kind: 'qr', payload: 'mock-qr' },
      expectedAmount: 500,
    });

    expect(result).toEqual({ ok: false, reason: 'DUPLICATE_SLIP' });
  });
});

describe('mock email provider', () => {
  it('captures sent messages in memory', async () => {
    const email = createMockEmailProvider();
    const result = await email.send({
      to: 'member@example.test',
      subject: 'test',
      html: '<p>test</p>',
      text: 'test',
    });

    expect(result).toEqual({ ok: true, providerEmailId: 'mock-email-1' });
    expect(email.sent).toHaveLength(1);
  });

  it('can simulate a provider failure', async () => {
    const email = createMockEmailProvider({ failWith: 'PROVIDER_ERROR' });
    const result = await email.send({
      to: 'member@example.test',
      subject: 'test',
      html: '<p>test</p>',
      text: 'test',
    });

    expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    expect(email.sent).toHaveLength(0);
  });
});
