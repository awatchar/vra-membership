import { describe, expect, it } from 'vitest';
import { CryptoError, createCitizenIdProtection } from '../../src/worker/lib/crypto';

/** Synthetic key material. Never a real `PII_ENCRYPTION_KEY`. */
const KEY = 'a'.repeat(48);
const OTHER_KEY = 'b'.repeat(48);
const CITIZEN_ID = '1234567890121';

describe('createCitizenIdProtection', () => {
  it('round-trips a citizen ID', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelope = await protection.encrypt(CITIZEN_ID);

    await expect(protection.decrypt(envelope)).resolves.toBe(CITIZEN_ID);
  });

  it('never stores the plaintext inside the envelope', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelope = await protection.encrypt(CITIZEN_ID);

    expect(envelope).not.toContain(CITIZEN_ID);
    expect(envelope.startsWith('v1.')).toBe(true);
  });

  it('produces a different envelope every time (random IV)', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelopes = await Promise.all(
      Array.from({ length: 5 }, () => protection.encrypt(CITIZEN_ID)),
    );

    expect(new Set(envelopes).size).toBe(5);
  });

  it('normalises before encrypting so formatting does not change the plaintext', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelope = await protection.encrypt('1-2345-67890-12-1');

    await expect(protection.decrypt(envelope)).resolves.toBe(CITIZEN_ID);
  });

  it('rejects an envelope produced with a different key', async () => {
    const first = await createCitizenIdProtection(KEY);
    const second = await createCitizenIdProtection(OTHER_KEY);
    const envelope = await first.encrypt(CITIZEN_ID);

    await expect(second.decrypt(envelope)).rejects.toThrow(CryptoError);
  });

  it('rejects a tampered envelope', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelope = await protection.encrypt(CITIZEN_ID);
    const [version, iv, ciphertext] = envelope.split('.');
    const flipped = `${ciphertext!.slice(0, -1)}${ciphertext!.at(-1) === 'A' ? 'B' : 'A'}`;

    await expect(protection.decrypt(`${version}.${iv}.${flipped}`)).rejects.toThrow(CryptoError);
  });

  it('rejects an envelope with an unknown version', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelope = await protection.encrypt(CITIZEN_ID);
    const rest = envelope.split('.').slice(1).join('.');

    await expect(protection.decrypt(`v2.${rest}`)).rejects.toThrow(CryptoError);
  });

  it('never echoes any part of the input in a failure message', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const envelope = await protection.encrypt(CITIZEN_ID);

    await expect(protection.decrypt(`v9.${envelope}`)).rejects.toThrow(
      /unsupported format|could not be decrypted/,
    );
    await protection.decrypt(envelope).catch((error: unknown) => {
      expect((error as Error).message).not.toContain(CITIZEN_ID);
    });
  });
});

describe('duplicate-lookup hash', () => {
  it('is stable for the same citizen ID', async () => {
    const protection = await createCitizenIdProtection(KEY);

    await expect(protection.hash(CITIZEN_ID)).resolves.toBe(await protection.hash(CITIZEN_ID));
  });

  it('is stable across separator styles', async () => {
    const protection = await createCitizenIdProtection(KEY);

    await expect(protection.hash('1-2345-67890-12-1')).resolves.toBe(
      await protection.hash(CITIZEN_ID),
    );
  });

  it('differs for a different citizen ID', async () => {
    const protection = await createCitizenIdProtection(KEY);

    await expect(protection.hash('1234567890121')).resolves.not.toBe(
      await protection.hash('1234567890139'),
    );
  });

  it('does not contain the plaintext', async () => {
    const protection = await createCitizenIdProtection(KEY);

    await expect(protection.hash(CITIZEN_ID)).resolves.not.toContain(CITIZEN_ID);
  });

  it('differs under a different key, so the index is key-bound', async () => {
    const first = await createCitizenIdProtection(KEY);
    const second = await createCitizenIdProtection(OTHER_KEY);

    await expect(first.hash(CITIZEN_ID)).resolves.not.toBe(await second.hash(CITIZEN_ID));
  });

  it('is not the encryption key in disguise: the hash cannot be decrypted', async () => {
    const protection = await createCitizenIdProtection(KEY);
    const hash = await protection.hash(CITIZEN_ID);

    await expect(protection.decrypt(`v1.${hash}.${hash}`)).rejects.toThrow(CryptoError);
  });
});

describe('key material validation', () => {
  it('rejects an empty key', async () => {
    await expect(createCitizenIdProtection('')).rejects.toThrow(CryptoError);
  });

  it('rejects a key that is too short to be meaningful', async () => {
    await expect(createCitizenIdProtection('short-key')).rejects.toThrow(/at least 32 bytes/);
  });

  it('never includes the key material in the error message', async () => {
    const secret = 'short-but-secret';
    await createCitizenIdProtection(secret).catch((error: unknown) => {
      expect((error as Error).message).not.toContain(secret);
    });
  });
});
