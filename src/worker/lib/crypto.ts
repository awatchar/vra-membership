/**
 * Protection for the one field in this system that must be readable again but
 * must never sit in the database in clear text: the citizen ID
 * (Issue #1 section 44).
 *
 * Two independent subkeys are derived from `PII_ENCRYPTION_KEY` with HKDF so
 * that the value used for duplicate lookups can never decrypt anything, and a
 * compromised lookup index cannot be turned into plaintext.
 *
 *   PII_ENCRYPTION_KEY
 *     |-- HKDF(info = "vra:citizen-id:aes-gcm:v1") -> AES-GCM key (encrypt/decrypt)
 *     |-- HKDF(info = "vra:citizen-id:hmac:v1")    -> HMAC key   (duplicate lookup)
 *
 * Ciphertext is stored as `v1.<base64url(iv)>.<base64url(ciphertext||tag)>`, so
 * the format carries its own version and a future key rotation can be detected
 * rather than guessed.
 */

import { normalizeCitizenId } from './citizen-id';

const ENVELOPE_VERSION = 'v1';
const IV_BYTE_LENGTH = 12;
const KEY_BIT_LENGTH = 256;
const MINIMUM_KEY_BYTES = 32;

const AES_INFO = 'vra:citizen-id:aes-gcm:v1';
const HMAC_INFO = 'vra:citizen-id:hmac:v1';

/** Thrown for malformed keys and malformed envelopes. Never contains a value. */
export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export interface CitizenIdProtection {
  /** Encrypts a citizen ID. Two calls on the same input differ (random IV). */
  encrypt(citizenId: string): Promise<string>;
  /** Decrypts an envelope produced by `encrypt`. */
  decrypt(envelope: string): Promise<string>;
  /** Stable keyed hash of the normalised citizen ID, for duplicate lookups. */
  hash(citizenId: string): Promise<string>;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Uses the secret's own UTF-8 bytes as HKDF input.
 *
 * Deliberately not "base64 if it decodes, text otherwise": that branch means a
 * plain-text key that happens to be valid base64 derives different subkeys from
 * the same string, which is exactly the kind of ambiguity that turns a key
 * rotation into unrecoverable ciphertext. The operator is told to generate the
 * secret with `openssl rand -base64 48` (see docs/deployment.md); HKDF accepts
 * input of any length, so no decoding step is needed.
 */
function decodeKeyMaterial(keyMaterial: string): Uint8Array {
  if (keyMaterial.length === 0) {
    throw new CryptoError('PII encryption key is empty');
  }

  const bytes = new TextEncoder().encode(keyMaterial);
  if (bytes.byteLength < MINIMUM_KEY_BYTES) {
    throw new CryptoError(
      `PII encryption key must provide at least ${MINIMUM_KEY_BYTES} bytes of material`,
    );
  }
  return bytes;
}

async function deriveBits(master: CryptoKey, info: string): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // A per-deployment salt would add nothing here: the `info` labels already
      // separate the subkeys and the master key is a high-entropy secret.
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(info),
    },
    master,
    KEY_BIT_LENGTH,
  );
}

export async function createCitizenIdProtection(keyMaterial: string): Promise<CitizenIdProtection> {
  const master = await crypto.subtle.importKey(
    'raw',
    decodeKeyMaterial(keyMaterial),
    'HKDF',
    false,
    ['deriveBits'],
  );

  const [aesBits, hmacBits] = await Promise.all([
    deriveBits(master, AES_INFO),
    deriveBits(master, HMAC_INFO),
  ]);

  const aesKey = await crypto.subtle.importKey('raw', aesBits, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    hmacBits,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  return {
    async encrypt(citizenId: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        new TextEncoder().encode(normalizeCitizenId(citizenId)),
      );
      return [ENVELOPE_VERSION, toBase64Url(iv), toBase64Url(new Uint8Array(ciphertext))].join('.');
    },

    async decrypt(envelope: string): Promise<string> {
      const parts = envelope.split('.');
      if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
        throw new CryptoError('Citizen ID envelope has an unsupported format');
      }

      let plaintext: ArrayBuffer;
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: fromBase64Url(parts[1]!) as BufferSource },
          aesKey,
          fromBase64Url(parts[2]!),
        );
      } catch {
        // Authentication failure or a wrong key. The reason is deliberately not
        // distinguished, and no fragment of the input is echoed back.
        throw new CryptoError('Citizen ID envelope could not be decrypted');
      }

      return new TextDecoder().decode(plaintext);
    },

    async hash(citizenId: string): Promise<string> {
      const signature = await crypto.subtle.sign(
        'HMAC',
        hmacKey,
        new TextEncoder().encode(normalizeCitizenId(citizenId)),
      );
      return toBase64Url(new Uint8Array(signature));
    },
  };
}
