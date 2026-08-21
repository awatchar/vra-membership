import { requireSecret } from '../env';
import type { WorkerEnv } from '../env';
import { createIappOcrProvider } from './iapp';
import { createResendProvider } from './resend';
import { createSlipOkProvider } from './slipok';
import { createMockEmailProvider } from './mock/email';
import { createMockOcrProvider } from './mock/ocr';
import { createMockSlipProvider } from './mock/slip';
import type { Providers } from './types';

export * from './types';

/**
 * Resolves the provider set for a request.
 *
 * `PROVIDER_MODE=mock` is the default for development and the only mode used by
 * automated tests. Each adapter is constructed lazily by a getter so a request
 * that never sends email does not require the email secrets to be configured,
 * and a missing secret fails loudly at the point of use rather than silently
 * falling back to a mock in production.
 */
export function createProviders(env: WorkerEnv): Providers {
  if (env.PROVIDER_MODE === 'mock') {
    return {
      ocr: createMockOcrProvider(),
      slip: createMockSlipProvider(),
      email: createMockEmailProvider(),
    };
  }

  return {
    get ocr() {
      return createIappOcrProvider({ apiKey: requireSecret(env, 'IAPP_API_KEY') });
    },
    get slip() {
      return createSlipOkProvider({
        apiKey: requireSecret(env, 'SLIPOK_API_KEY'),
        branchId: requireSecret(env, 'SLIPOK_BRANCH_ID'),
      });
    },
    get email() {
      // Open tracking is a property of the sending domain in Resend, so asking
      // for it means sending from a different, separately configured sender.
      // Without `EMAIL_FROM_TRACKED` the manager's opens are simply not
      // tracked, which the flow already tolerates (Issue #1 section 34).
      const trackedFrom = env['EMAIL_FROM_TRACKED'];
      return createResendProvider({
        apiKey: requireSecret(env, 'RESEND_API_KEY'),
        from: requireSecret(env, 'EMAIL_FROM'),
        ...(typeof trackedFrom === 'string' && trackedFrom.length > 0 ? { trackedFrom } : {}),
      });
    },
  };
}
