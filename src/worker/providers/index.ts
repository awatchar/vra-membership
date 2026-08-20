import { requireSecret } from '../env';
import type { WorkerEnv } from '../env';
import { createIappOcrProvider } from './iapp';
import { createMockEmailProvider } from './mock/email';
import { createMockOcrProvider } from './mock/ocr';
import { createMockSlipProvider } from './mock/slip';
import type { Providers } from './types';

export * from './types';

/**
 * Thrown when a live adapter is requested before it exists or before its secret
 * is configured. Surfaces as `PROVIDER_UNAVAILABLE` rather than leaking details.
 */
export class ProviderNotConfiguredError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Live provider adapter is not available: ${provider}`);
    this.name = 'ProviderNotConfiguredError';
    this.provider = provider;
  }
}

/**
 * Resolves the provider set for a request.
 *
 * `PROVIDER_MODE=mock` is the default for development and the only mode used by
 * automated tests. Live adapters for iApp, SlipOK and Resend are added by their
 * own issues; until then requesting `live` fails loudly instead of silently
 * falling back to mocks in production.
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
    get slip(): never {
      throw new ProviderNotConfiguredError('slipok');
    },
    get email(): never {
      throw new ProviderNotConfiguredError('resend');
    },
  };
}
