import type { Repository } from '../db';
import { ApiError } from '../lib/http';
import type { KeyedHasher } from '../lib/crypto';

/**
 * Applicant access to their own application.
 *
 * The application id is a UUID that appears in URLs and on the confirmation
 * page, so it is not a secret. If the id alone were enough to read an
 * application, anyone who saw one - in a browser history, a screenshot, a
 * support ticket - could read that person's citizen ID, address and phone
 * number. Guessing is not the threat; incidental exposure is.
 *
 * So the applicant gets a capability: a long random token issued once at
 * creation and presented on every later request. Only a keyed hash is stored,
 * for the same reason the citizen ID is only stored encrypted - a copy of the
 * database must not hand over working credentials.
 *
 * There is no login, no password and no account, which is what Issue #1
 * intends: the applicant fills in a form once and never comes back.
 */

export const ACCESS_TOKEN_HEADER = 'x-vra-application-token';
export const ACCESS_TOKEN_HASH_INFO = 'vra:application-access:v1';

const TOKEN_BYTE_LENGTH = 32;

const MESSAGES = {
  denied: 'ไม่สามารถเข้าถึงใบสมัครนี้ได้ กรุณาเริ่มขั้นตอนใหม่',
} as const;

/** A fresh capability token. Returned to the applicant exactly once. */
export function generateAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function readAccessToken(request: Request): string | null {
  const value = request.headers.get(ACCESS_TOKEN_HEADER);
  return value && value.length > 0 ? value : null;
}

export interface ApplicationAccess {
  /** Hash of a token, for storing or comparing. */
  hash(token: string): Promise<string>;
  /**
   * Resolves the application a request is entitled to read.
   *
   * Throws `NOT_FOUND` for a missing token, a wrong token and a missing
   * application alike. Distinguishing them would let a caller confirm that an
   * application id exists, which is information they have not earned.
   */
  authorize(request: Request, applicationId: string): Promise<string>;
}

export function createApplicationAccess(db: Repository, hasher: KeyedHasher): ApplicationAccess {
  return {
    async hash(token) {
      return hasher.hash(token);
    },

    async authorize(request, applicationId) {
      const token = readAccessToken(request);
      if (!token) {
        throw new ApiError('NOT_FOUND', MESSAGES.denied);
      }

      const application = await db.applications.findById(applicationId);
      // A row with no stored hash cannot be read by anyone, which is the right
      // failure mode for a row that predates the capability model.
      if (!application?.accessTokenHash) {
        throw new ApiError('NOT_FOUND', MESSAGES.denied);
      }

      // Comparing hashes rather than tokens: the stored value is a hash, and the
      // hash of a wrong token differs in a way no timing side channel can be
      // walked back to the right one.
      if ((await hasher.hash(token)) !== application.accessTokenHash) {
        throw new ApiError('NOT_FOUND', MESSAGES.denied);
      }

      return application.id;
    },
  };
}
