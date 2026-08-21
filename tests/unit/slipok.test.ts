import { describe, expect, it } from 'vitest';
import { createSlipOkProvider } from '../../src/worker/providers/slipok';

const VERIFIED_RESPONSE = {
  success: true,
  data: {
    success: true,
    transRef: 'TEST-TRANSACTION-0001',
    transTimestamp: '2026-08-20T03:04:05.000Z',
    amount: 500,
    sendingBank: '002',
    receivingBank: '014',
    receiver: {
      displayName: 'สมาคมตัวอย่าง',
      account: { type: 'BANKAC', value: 'xxx-x-x7890-x' },
    },
  },
};

function providerWith(handler: (request: Request) => Promise<Response> | Response) {
  const calls: Request[] = [];
  const provider = createSlipOkProvider({
    apiKey: 'test-only-key',
    branchId: 'test-branch',
    baseUrl: 'https://slip.example.test/api',
  });
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    return handler(request);
  };
  return { provider, calls, restore: () => (globalThis.fetch = original) };
}

describe('createSlipOkProvider transport', () => {
  it('sends QR data, the server-resolved amount and duplicate logging as JSON', async () => {
    const { provider, calls, restore } = providerWith(
      () => new Response(JSON.stringify(VERIFIED_RESPONSE), { status: 200 }),
    );

    try {
      await provider.verify({
        evidence: { kind: 'qr', payload: 'synthetic-bank-qr-payload' },
        expectedAmount: 50_000,
      });

      const request = calls[0]!;
      expect(request.url).toBe('https://slip.example.test/api/test-branch');
      expect(request.headers.get('x-authorization')).toBe('test-only-key');
      await expect(request.json()).resolves.toEqual({
        data: 'synthetic-bank-qr-payload',
        amount: 500,
        log: true,
      });
    } finally {
      restore();
    }
  });

  it.each([
    ['image/jpeg', 'slip.jpg'],
    ['image/png', 'slip.png'],
    ['image/webp', 'slip.webp'],
  ])(
    'gives a %s image a neutral filename with the required extension',
    async (contentType, name) => {
      const { provider, calls, restore } = providerWith(
        () => new Response(JSON.stringify(VERIFIED_RESPONSE), { status: 200 }),
      );

      try {
        await provider.verify({
          evidence: {
            kind: 'image',
            image: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), contentType },
          },
          expectedAmount: 50_000,
        });

        const request = calls[0]!;
        expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
        const form = await request.formData();
        const file = form.get('files');
        expect(file).toBeInstanceOf(File);
        if (!(file instanceof File)) throw new Error('expected multipart file');
        expect(file.name).toBe(name);
        expect(file.type).toBe(contentType);
        expect(form.get('amount')).toBe('500');
        expect(form.get('log')).toBe('true');
      } finally {
        restore();
      }
    },
  );

  it('passes verified 1014 data to the local receiver and payment checks', async () => {
    const response = { ...VERIFIED_RESPONSE, code: 1014, message: 'receiver differs' };
    const { provider, restore } = providerWith(
      () => new Response(JSON.stringify(response), { status: 400 }),
    );

    try {
      await expect(
        provider.verify({
          evidence: { kind: 'qr', payload: 'synthetic-bank-qr-payload' },
          expectedAmount: 50_000,
        }),
      ).resolves.toMatchObject({
        ok: true,
        transaction: {
          transactionRef: 'TEST-TRANSACTION-0001',
          amount: 50_000,
          receiverAccountDigits: '7890',
        },
      });
    } finally {
      restore();
    }
  });

  it('keeps a 1014 response without a complete verified transaction fail-closed', async () => {
    const { provider, restore } = providerWith(
      () => new Response(JSON.stringify({ code: 1014, data: { success: false } }), { status: 400 }),
    );

    try {
      await expect(
        provider.verify({
          evidence: { kind: 'qr', payload: 'synthetic-bank-qr-payload' },
          expectedAmount: 50_000,
        }),
      ).resolves.toEqual({ ok: false, reason: 'PROVIDER_ERROR' });
    } finally {
      restore();
    }
  });

  it.each([
    [1005, 'SLIP_UNREADABLE'],
    [1009, 'PROVIDER_ERROR'],
    [1011, 'SLIP_NOT_FOUND'],
    [1012, 'DUPLICATE_SLIP'],
    [1013, 'AMOUNT_MISMATCH'],
  ] as const)('maps documented error %i to %s', async (code, reason) => {
    const { provider, restore } = providerWith(
      () => new Response(JSON.stringify({ code }), { status: 400 }),
    );

    try {
      await expect(
        provider.verify({
          evidence: { kind: 'qr', payload: 'synthetic-bank-qr-payload' },
          expectedAmount: 50_000,
        }),
      ).resolves.toEqual({ ok: false, reason });
    } finally {
      restore();
    }
  });
});
