import { z } from 'zod';

/**
 * Worker environment.
 *
 * `Env` is generated from `wrangler.jsonc` by `npm run cf-typegen`; this module
 * narrows it and validates the values the application actually depends on.
 * Secrets are declared as optional here because they are absent in local
 * development and in CI, and each feature validates the secret it needs at the
 * point of use. Their values are never logged.
 */

export const providerModeSchema = z.enum(['mock', 'live']);
export type ProviderMode = z.infer<typeof providerModeSchema>;

export const environmentNameSchema = z.enum(['development', 'staging', 'production']);
export type EnvironmentName = z.infer<typeof environmentNameSchema>;

export interface WorkerBindings {
  DB: D1Database;
  MEMBER_PHOTOS: R2Bucket;
  ASSETS: Fetcher;
}

export interface WorkerConfig {
  ENVIRONMENT: EnvironmentName;
  PROVIDER_MODE: ProviderMode;
  APP_BASE_URL: string;
  EMAIL_CC: string;
}

export type WorkerEnv = WorkerBindings & WorkerConfig & Record<string, unknown>;

const configSchema = z.object({
  ENVIRONMENT: environmentNameSchema,
  PROVIDER_MODE: providerModeSchema,
  APP_BASE_URL: z.string().url(),
  EMAIL_CC: z.string().email(),
});

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Validates non-secret configuration at request time.
 *
 * Throws `ConfigurationError` with the offending variable names only - never
 * their values, so a misconfigured secret cannot leak through an error message.
 */
export function readConfig(env: Record<string, unknown>): WorkerConfig {
  const parsed = configSchema.safeParse({
    ENVIRONMENT: env['ENVIRONMENT'],
    PROVIDER_MODE: env['PROVIDER_MODE'],
    APP_BASE_URL: env['APP_BASE_URL'],
    EMAIL_CC: env['EMAIL_CC'],
  });

  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
    throw new ConfigurationError(`Invalid worker configuration: ${names.join(', ')}`);
  }

  if (parsed.data.ENVIRONMENT === 'production' && parsed.data.PROVIDER_MODE !== 'live') {
    throw new ConfigurationError('Invalid worker configuration: PROVIDER_MODE');
  }

  return parsed.data;
}

/**
 * Reads a required secret without ever surfacing its value.
 * Callers should invoke this only inside the feature that needs the secret.
 */
export function requireSecret(env: Record<string, unknown>, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigurationError(`Missing required secret: ${name}`);
  }
  return value;
}
