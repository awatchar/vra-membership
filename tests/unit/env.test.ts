import { describe, expect, it } from 'vitest';
import { ConfigurationError, readConfig, requireSecret } from '../../src/worker/env';

const validConfig = {
  ENVIRONMENT: 'development',
  PROVIDER_MODE: 'mock',
  APP_BASE_URL: 'http://localhost:8787',
};

describe('readConfig', () => {
  it('accepts a valid configuration', () => {
    expect(readConfig(validConfig)).toEqual(validConfig);
  });

  it('rejects an unknown environment name', () => {
    expect(() => readConfig({ ...validConfig, ENVIRONMENT: 'prod' })).toThrow(ConfigurationError);
  });

  it('rejects mock providers in production', () => {
    expect(() =>
      readConfig({
        ENVIRONMENT: 'production',
        PROVIDER_MODE: 'mock',
        APP_BASE_URL: 'https://member.vra.or.th',
      }),
    ).toThrow(/PROVIDER_MODE/);
  });

  it('reports variable names without their values', () => {
    try {
      readConfig({ ...validConfig, APP_BASE_URL: 'not-a-url-value' });
      expect.unreachable('readConfig should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('APP_BASE_URL');
      expect((error as Error).message).not.toContain('not-a-url-value');
    }
  });
});

describe('requireSecret', () => {
  it('returns the configured value', () => {
    expect(requireSecret({ RESEND_API_KEY: 'value' }, 'RESEND_API_KEY')).toBe('value');
  });

  it('throws with the name only when a secret is missing', () => {
    expect(() => requireSecret({}, 'RESEND_API_KEY')).toThrow(
      'Missing required secret: RESEND_API_KEY',
    );
  });

  it('treats an empty string as missing', () => {
    expect(() => requireSecret({ RESEND_API_KEY: '' }, 'RESEND_API_KEY')).toThrow(
      ConfigurationError,
    );
  });
});
