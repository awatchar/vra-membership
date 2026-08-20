import { describe, expect, it } from 'vitest';
import type { WorkerEnv } from '../../src/worker/env';
import { ProviderNotConfiguredError, createProviders } from '../../src/worker/providers';
import { createMockEmailProvider } from '../../src/worker/providers/mock/email';
import { createMockOcrProvider } from '../../src/worker/providers/mock/ocr';
import { createMockSlipProvider } from '../../src/worker/providers/mock/slip';

function fakeEnv(providerMode: 'mock' | 'live'): WorkerEnv {
  return { PROVIDER_MODE: providerMode } as unknown as WorkerEnv;
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

  it('fails loudly instead of falling back to mocks in live mode', () => {
    const providers = createProviders(fakeEnv('live'));

    expect(() => providers.ocr).toThrow(ProviderNotConfiguredError);
    expect(() => providers.slip).toThrow(ProviderNotConfiguredError);
    expect(() => providers.email).toThrow(ProviderNotConfiguredError);
  });
});

describe('mock OCR provider', () => {
  it('returns only the fields the membership process needs', async () => {
    const result = await createMockOcrProvider().readThaiIdCardFront({
      bytes: new Uint8Array([1, 2, 3]),
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

  it('can be configured to fail', async () => {
    const provider = createMockOcrProvider({ failWith: 'PROVIDER_TIMEOUT' });
    const result = await provider.readThaiIdCardFront({
      bytes: new Uint8Array([1]),
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
