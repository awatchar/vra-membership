import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('GET /api/health', () => {
  it('reports the environment and provider mode', async () => {
    const response = await exports.default.fetch(new Request('http://localhost/api/health'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      environment: 'development',
      providerMode: 'mock',
    });
  });

  it('never runs automated tests against live providers', () => {
    expect(env.PROVIDER_MODE).toBe('mock');
  });
});

describe('unknown routes', () => {
  it('returns a JSON error for unknown API paths', async () => {
    const response = await exports.default.fetch(
      new Request('http://localhost/api/does-not-exist'),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });
});

describe('bindings', () => {
  it('exposes the D1 database binding', async () => {
    const result = await env.DB.prepare('select 1 as ok').first<{ ok: number }>();
    expect(result?.ok).toBe(1);
  });

  it('exposes the private member photo bucket binding', async () => {
    await env.MEMBER_PHOTOS.put('test-object', 'x');
    const object = await env.MEMBER_PHOTOS.get('test-object');
    expect(object).not.toBeNull();
  });
});
