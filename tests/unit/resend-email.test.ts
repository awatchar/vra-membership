import { describe, expect, it } from 'vitest';
import { createResendProvider } from '../../src/worker/providers/resend';
import type { OutboundEmail } from '../../src/worker/providers/types';

/**
 * Resend adapter behaviour, exercised against a stub `fetch`. The real endpoint
 * is never called: automated tests must not reach a provider (AGENTS.md).
 */

const BASE_URL = 'https://resend.example.test';

function email(overrides: Partial<OutboundEmail> = {}): OutboundEmail {
  return {
    to: 'member@example.test',
    subject: 'ทดสอบ',
    html: '<p>ทดสอบ</p>',
    text: 'ทดสอบ',
    ...overrides,
  };
}

function providerWith(
  handler: (request: Request) => Promise<Response> | Response,
  options: { trackedFrom?: string } = {},
) {
  const calls: Request[] = [];
  const provider = createResendProvider({
    apiKey: 'test-only-key',
    from: 'VRA <membership@example.test>',
    baseUrl: BASE_URL,
    ...(options.trackedFrom ? { trackedFrom: options.trackedFrom } : {}),
  });

  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    return handler(request);
  };

  return { provider, calls, restore: () => (globalThis.fetch = original) };
}

function accepted(id = 'resend-id-1'): Response {
  return new Response(JSON.stringify({ id }), { status: 200 });
}

function rejected(name: string, status: number): Response {
  return new Response(JSON.stringify({ name, message: 'irrelevant' }), { status });
}

describe('sending', () => {
  it('posts to the emails endpoint with the api key as a bearer token', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      const result = await provider.send(email());

      expect(result).toEqual({ ok: true, providerEmailId: 'resend-id-1' });
      const request = calls[0]!;
      expect(request.method).toBe('POST');
      expect(request.url).toBe(`${BASE_URL}/emails`);
      expect(request.headers.get('authorization')).toBe('Bearer test-only-key');
    } finally {
      restore();
    }
  });

  it('sends both the HTML and the plain-text body', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      await provider.send(email());

      const body = await calls[0]!.json<Record<string, unknown>>();
      expect(body['html']).toBe('<p>ทดสอบ</p>');
      expect(body['text']).toBe('ทดสอบ');
      expect(body['from']).toBe('VRA <membership@example.test>');
    } finally {
      restore();
    }
  });

  it('passes CC recipients in the provider payload', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      await provider.send(email({ cc: ['copy@example.test'] }));

      const body = await calls[0]!.json<Record<string, unknown>>();
      expect(body['cc']).toEqual(['copy@example.test']);
    } finally {
      restore();
    }
  });

  it('passes the idempotency key as a header', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      await provider.send(email({ idempotencyKey: 'email-row-1' }));

      expect(calls[0]!.headers.get('idempotency-key')).toBe('email-row-1');
    } finally {
      restore();
    }
  });

  it('omits the idempotency header when there is no key', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      await provider.send(email());

      // An empty header would be a 400 (`invalid_idempotency_key`) rather than
      // simply not deduplicating.
      expect(calls[0]!.headers.get('idempotency-key')).toBeNull();
    } finally {
      restore();
    }
  });

  it('base64-encodes an attachment with its content type', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    const content = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
    try {
      await provider.send(
        email({
          attachments: [{ filename: 'receipt.pdf', contentType: 'application/pdf', content }],
        }),
      );

      const body = await calls[0]!.json<{ attachments: Record<string, string>[] }>();
      expect(body.attachments).toHaveLength(1);
      expect(body.attachments[0]!['filename']).toBe('receipt.pdf');
      expect(body.attachments[0]!['content_type']).toBe('application/pdf');
      expect(atob(body.attachments[0]!['content']!)).toBe('%PDF-');
    } finally {
      restore();
    }
  });

  it('encodes an attachment larger than one chunk without corrupting it', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    // Chunked encoding exists so a real receipt cannot blow the argument limit
    // of `String.fromCharCode`; this is larger than one chunk.
    const content = new Uint8Array(0x8000 + 17);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;

    try {
      await provider.send(
        email({
          attachments: [{ filename: 'big.pdf', contentType: 'application/pdf', content }],
        }),
      );

      const body = await calls[0]!.json<{ attachments: Record<string, string>[] }>();
      const decoded = atob(body.attachments[0]!['content']!);
      expect(decoded.length).toBe(content.length);
      expect(decoded.charCodeAt(0x8000)).toBe(0x8000 % 251);
      expect(decoded.charCodeAt(decoded.length - 1)).toBe((content.length - 1) % 251);
    } finally {
      restore();
    }
  });

  it('converts tags to the array form', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      await provider.send(email({ tags: { emailType: 'RECEIPT' } }));

      const body = await calls[0]!.json<{ tags: unknown }>();
      expect(body.tags).toEqual([{ name: 'emailType', value: 'RECEIPT' }]);
    } finally {
      restore();
    }
  });

  it('drops a tag outside the allowed alphabet rather than failing the send', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      const result = await provider.send(
        email({ tags: { emailType: 'RECEIPT', 'bad key': 'ทดสอบ' } }),
      );

      expect(result.ok).toBe(true);
      const body = await calls[0]!.json<{ tags: unknown }>();
      expect(body.tags).toEqual([{ name: 'emailType', value: 'RECEIPT' }]);
    } finally {
      restore();
    }
  });
});

describe('open tracking', () => {
  it('sends from the tracked sender when tracking is asked for', async () => {
    const { provider, calls, restore } = providerWith(() => accepted(), {
      trackedFrom: 'VRA <notify@track.example.test>',
    });
    try {
      await provider.send(email({ trackOpens: true }));

      // Resend has no per-message tracking flag: tracking is a property of the
      // sending domain, so asking for it means using the other sender.
      const body = await calls[0]!.json<Record<string, unknown>>();
      expect(body['from']).toBe('VRA <notify@track.example.test>');
    } finally {
      restore();
    }
  });

  it('falls back to the normal sender when no tracked sender is configured', async () => {
    const { provider, calls, restore } = providerWith(() => accepted());
    try {
      await provider.send(email({ trackOpens: true }));

      const body = await calls[0]!.json<Record<string, unknown>>();
      expect(body['from']).toBe('VRA <membership@example.test>');
    } finally {
      restore();
    }
  });

  it('uses the normal sender for everything else', async () => {
    const { provider, calls, restore } = providerWith(() => accepted(), {
      trackedFrom: 'VRA <notify@track.example.test>',
    });
    try {
      await provider.send(email());

      const body = await calls[0]!.json<Record<string, unknown>>();
      expect(body['from']).toBe('VRA <membership@example.test>');
    } finally {
      restore();
    }
  });
});

describe('failure classification', () => {
  const permanent = ['validation_error', 'invalid_from_address', 'invalid_attachment'];
  const transient = ['rate_limit_exceeded', 'daily_quota_exceeded', 'internal_server_error'];

  for (const name of permanent) {
    it(`reports ${name} as rejected, because a retry would fail the same way`, async () => {
      const { provider, restore } = providerWith(() => rejected(name, 422));
      try {
        expect(await provider.send(email())).toEqual({ ok: false, reason: 'REJECTED' });
      } finally {
        restore();
      }
    });
  }

  for (const name of transient) {
    it(`keeps ${name} retryable`, async () => {
      const { provider, restore } = providerWith(() => rejected(name, 429));
      try {
        expect(await provider.send(email())).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
      } finally {
        restore();
      }
    });
  }

  it('classifies an unmapped 5xx as retryable and an unmapped 4xx as not', async () => {
    const server = providerWith(() => new Response('{}', { status: 503 }));
    try {
      expect(await server.provider.send(email())).toEqual({
        ok: false,
        reason: 'PROVIDER_ERROR',
      });
    } finally {
      server.restore();
    }

    const client = providerWith(() => new Response('{}', { status: 418 }));
    try {
      expect(await client.provider.send(email())).toEqual({ ok: false, reason: 'REJECTED' });
    } finally {
      client.restore();
    }
  });

  it('treats a 200 without an id as a provider error', async () => {
    const { provider, restore } = providerWith(() => new Response('{}', { status: 200 }));
    try {
      // Reporting success would leave a row that no webhook could be matched to.
      expect(await provider.send(email())).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    } finally {
      restore();
    }
  });

  it('reports a network failure without throwing', async () => {
    const { provider, restore } = providerWith(() => {
      throw new TypeError('network down');
    });
    try {
      expect(await provider.send(email())).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    } finally {
      restore();
    }
  });

  it('reports a timeout as a timeout', async () => {
    const { provider, restore } = providerWith(() => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    });
    try {
      expect(await provider.send(email())).toEqual({ ok: false, reason: 'PROVIDER_TIMEOUT' });
    } finally {
      restore();
    }
  });

  it('never puts the api key in an error path', async () => {
    const { provider, calls, restore } = providerWith(() => rejected('invalid_api_key', 403));
    try {
      const result = await provider.send(email());

      expect(result).toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
      expect(JSON.stringify(result)).not.toContain('test-only-key');
      // The key is in the request, which is where it belongs, and nowhere else.
      expect(calls[0]!.headers.get('authorization')).toContain('test-only-key');
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------- webhook verification ---- */

const SECRET_BYTES = new Uint8Array(32).fill(7);
const SECRET = `whsec_${btoa(String.fromCharCode(...SECRET_BYTES))}`;

async function sign(id: string, timestamp: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    SECRET_BYTES,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = new TextEncoder().encode(`${id}.${timestamp}.${payload}`);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, signed));
  return btoa(String.fromCharCode(...mac));
}

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

describe('webhook signature, against the published Svix vector', () => {
  // From Svix's own manual-verification documentation. Checking against a
  // signature computed elsewhere is the only way to know the format was
  // understood correctly rather than misunderstood consistently: a self-signed
  // fixture would pass even if the signed-content string were wrong.
  const VECTOR = {
    secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    timestamp: '1614265330',
    payload: '{"test": 2432232314}',
    signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  };

  /** Fixed at the vector's own timestamp, which is otherwise long expired. */
  const atVectorTime = createResendProvider({
    apiKey: 'unused',
    from: 'a@example.test',
    now: () => new Date(Number(VECTOR.timestamp) * 1000),
  });

  it('accepts the documented signature', async () => {
    await expect(
      atVectorTime.verifyWebhookSignature({
        payload: VECTOR.payload,
        secret: VECTOR.secret,
        headers: headers({
          'svix-id': VECTOR.id,
          'svix-timestamp': VECTOR.timestamp,
          'svix-signature': VECTOR.signature,
        }),
      }),
    ).resolves.toBe(true);
  });

  it('rejects it once the body whitespace changes', async () => {
    // The raw body is what was signed. Re-serialising parsed JSON would drop
    // the space after the colon and every signature would stop matching.
    await expect(
      atVectorTime.verifyWebhookSignature({
        payload: '{"test":2432232314}',
        secret: VECTOR.secret,
        headers: headers({
          'svix-id': VECTOR.id,
          'svix-timestamp': VECTOR.timestamp,
          'svix-signature': VECTOR.signature,
        }),
      }),
    ).resolves.toBe(false);
  });
});

describe('webhook signature', () => {
  const provider = createResendProvider({ apiKey: 'unused', from: 'a@example.test' });
  const payload = JSON.stringify({ type: 'email.delivered' });

  it('accepts a correctly signed request', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();
    const signature = await sign(id, timestamp, payload);

    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        }),
      }),
    ).resolves.toBe(true);
  });

  it('accepts a secret without the whsec_ prefix', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();
    const signature = await sign(id, timestamp, payload);

    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET.slice('whsec_'.length),
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        }),
      }),
    ).resolves.toBe(true);
  });

  it('accepts one valid signature among several, so a secret can be rotated', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();
    const signature = await sign(id, timestamp, payload);

    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,AAAA${'A'.repeat(40)} v1,${signature}`,
        }),
      }),
    ).resolves.toBe(true);
  });

  it('rejects a payload that was altered after signing', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();
    const signature = await sign(id, timestamp, payload);

    await expect(
      provider.verifyWebhookSignature({
        payload: JSON.stringify({ type: 'email.bounced' }),
        secret: SECRET,
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('rejects a signature that belongs to a different message id', async () => {
    const timestamp = nowSeconds();
    const signature = await sign('msg_1', timestamp, payload);

    // The id is part of the signed content, so a replay under another id fails.
    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': 'msg_2',
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('rejects a request older than the tolerance', async () => {
    const id = 'msg_1';
    const timestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const signature = await sign(id, timestamp, payload);

    // A valid signature stays valid forever; without this check a captured
    // delivery webhook could be replayed indefinitely.
    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('rejects a timestamp too far in the future', async () => {
    const id = 'msg_1';
    const timestamp = String(Math.floor(Date.now() / 1000) + 6 * 60);
    const signature = await sign(id, timestamp, payload);

    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v1,${signature}`,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('rejects an unknown signature version', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();
    const signature = await sign(id, timestamp, payload);

    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': `v2,${signature}`,
        }),
      }),
    ).resolves.toBe(false);
  });

  it('rejects a request missing any of the three headers', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();
    const signature = await sign(id, timestamp, payload);
    const complete = {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    };

    for (const missing of Object.keys(complete)) {
      const partial = { ...complete };
      delete partial[missing as keyof typeof complete];
      await expect(
        provider.verifyWebhookSignature({ payload, secret: SECRET, headers: headers(partial) }),
      ).resolves.toBe(false);
    }
  });

  it('rejects a non-numeric timestamp', async () => {
    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: SECRET,
        headers: headers({
          'svix-id': 'msg_1',
          'svix-timestamp': 'not-a-number',
          'svix-signature': 'v1,AAAA',
        }),
      }),
    ).resolves.toBe(false);
  });

  it('rejects rather than throwing when the secret is not valid base64', async () => {
    const id = 'msg_1';
    const timestamp = nowSeconds();

    await expect(
      provider.verifyWebhookSignature({
        payload,
        secret: 'whsec_!!!not-base64!!!',
        headers: headers({
          'svix-id': id,
          'svix-timestamp': timestamp,
          'svix-signature': 'v1,AAAA',
        }),
      }),
    ).resolves.toBe(false);
  });
});
