import { describe, expect, it } from 'vitest';
import { sanitizeAuditMetadata } from '../../src/worker/services/audit';

/**
 * The audit trail must not become a second store of personal data
 * (Issue #1 section 49). The allowlist below is the enforcement point, so these
 * cases assert on the fields that would actually be tempting to attach.
 */
describe('sanitizeAuditMetadata', () => {
  it('keeps allowlisted keys', () => {
    expect(
      sanitizeAuditMetadata({
        from: 'SUBMITTED',
        to: 'NBTC_PROCESSING',
        amountSatang: 50_000,
        receiptNo: 'VRA-RC-2569-000001',
      }),
    ).toEqual({
      from: 'SUBMITTED',
      to: 'NBTC_PROCESSING',
      amountSatang: 50_000,
      receiptNo: 'VRA-RC-2569-000001',
    });
  });

  it('drops personal data even when the value is a primitive', () => {
    const sanitized = sanitizeAuditMetadata({
      to: 'SUBMITTED',
      ...({
        citizenId: '1234567890121',
        firstName: 'redacted',
        lastName: 'redacted',
        address: 'redacted',
        email: 'member@example.test',
        phone: '0800000000',
        callsign: 'HS0TEST',
        photoKey: 'member-photos/abc.jpg',
      } as Record<string, string>),
    });

    expect(sanitized).toEqual({ to: 'SUBMITTED' });
  });

  it('drops values that are not primitives', () => {
    const sanitized = sanitizeAuditMetadata({
      from: 'DRAFT',
      ...({ reason: { providerResponse: 'anything' } } as unknown as { reason: string }),
    });

    expect(sanitized).toEqual({ from: 'DRAFT' });
  });

  it('drops an allowlisted string that is long enough to be a payload', () => {
    const sanitized = sanitizeAuditMetadata({ reason: 'x'.repeat(65), to: 'REJECTED' });

    expect(sanitized).toEqual({ to: 'REJECTED' });
  });

  it('keeps an allowlisted string at the length limit', () => {
    const sanitized = sanitizeAuditMetadata({ reason: 'x'.repeat(64) });

    expect(sanitized).toEqual({ reason: 'x'.repeat(64) });
  });

  it('returns undefined rather than an empty object when nothing survives', () => {
    expect(
      sanitizeAuditMetadata({ ...({ citizenId: '1234567890121' } as Record<string, string>) }),
    ).toBeUndefined();
  });

  it('passes undefined through', () => {
    expect(sanitizeAuditMetadata(undefined)).toBeUndefined();
  });
});
