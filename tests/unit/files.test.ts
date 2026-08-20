import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/worker/lib/http';
import { readValidatedImage, sniffImageType, validateImageBytes } from '../../src/worker/lib/files';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

function webp(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x10, 0x00, 0x00, 0x00], 4); // size
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
  return bytes;
}

/** A RIFF container that is not WebP: this is what a naive check would accept. */
function riffWave(): Uint8Array {
  const bytes = new Uint8Array(16);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  return bytes;
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const SCRIPT = new TextEncoder().encode('#!/bin/sh\nrm -rf /\n');

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request('http://localhost/api/ocr', {
    method: 'POST',
    body: stream,
    headers,
    // Required by the Fetch spec when the body is a stream.
    duplex: 'half',
  } as RequestInit);
}

describe('sniffImageType', () => {
  it('recognises JPEG, PNG and WebP', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(webp())).toBe('image/webp');
  });

  it('rejects a RIFF container that is not WebP', () => {
    expect(sniffImageType(riffWave())).toBeNull();
  });

  it('rejects a PDF and a shell script', () => {
    expect(sniffImageType(PDF)).toBeNull();
    expect(sniffImageType(SCRIPT)).toBeNull();
  });

  it('rejects an empty or truncated header', () => {
    expect(sniffImageType(new Uint8Array())).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('validateImageBytes', () => {
  it('returns the sniffed type, not a declared one', () => {
    expect(validateImageBytes(PNG, { maxBytes: 1000 })).toEqual({
      bytes: PNG,
      contentType: 'image/png',
    });
  });

  it('rejects a file whose real type is not an allowed image', () => {
    // A PDF renamed to .jpg is exactly the case the declared type would miss.
    try {
      validateImageBytes(PDF, { maxBytes: 1000 });
      expect.unreachable('validateImageBytes should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('rejects a supported image that the caller did not allow', () => {
    try {
      validateImageBytes(PNG, { maxBytes: 1000, allowedTypes: ['image/jpeg'] });
      expect.unreachable('validateImageBytes should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('rejects a file over the limit', () => {
    const large = new Uint8Array(200);
    large.set(JPEG, 0);

    try {
      validateImageBytes(large, { maxBytes: 100 });
      expect.unreachable('validateImageBytes should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
    }
  });

  it('rejects an empty file', () => {
    try {
      validateImageBytes(new Uint8Array(), { maxBytes: 100 });
      expect.unreachable('validateImageBytes should have thrown');
    } catch (error) {
      expect((error as ApiError).code).toBe('BAD_REQUEST');
    }
  });

  it('never echoes file content in the message shown to the applicant', () => {
    try {
      validateImageBytes(SCRIPT, { maxBytes: 1000 });
      expect.unreachable('validateImageBytes should have thrown');
    } catch (error) {
      expect((error as ApiError).publicMessage).not.toContain('rm -rf');
    }
  });
});

describe('readValidatedImage', () => {
  it('reads a valid image from the body stream', async () => {
    const request = streamRequest([JPEG]);

    await expect(readValidatedImage(request, { maxBytes: 1000 })).resolves.toMatchObject({
      contentType: 'image/jpeg',
    });
  });

  it('reassembles a body that arrives in several chunks', async () => {
    const request = streamRequest([JPEG.slice(0, 2), JPEG.slice(2)]);

    const image = await readValidatedImage(request, { maxBytes: 1000 });
    expect(image.contentType).toBe('image/jpeg');
    expect(image.bytes).toEqual(JPEG);
  });

  it('rejects a body that exceeds the limit while streaming', async () => {
    // Ten chunks of 100 bytes against a 500-byte limit: the read must stop
    // rather than buffer the whole thing and measure afterwards.
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(100));
    chunks[0]!.set(JPEG, 0);

    await expect(readValidatedImage(streamRequest(chunks), { maxBytes: 500 })).rejects.toThrow(
      ApiError,
    );
  });

  it('rejects an oversized Content-Length before validating the bytes', async () => {
    // The declared length is the cheap pre-check. It cannot be asserted by
    // observing that the stream was never pulled, because the runtime consumes
    // the body when the Request is constructed - so this asserts the outcome
    // instead: a valid JPEG is still rejected, and rejected as too large rather
    // than for its content.
    const request = streamRequest([JPEG], { 'content-length': '999999999' });

    const error = await readValidatedImage(request, { maxBytes: 500 }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('does not trust a Content-Length that understates the real size', async () => {
    const chunks = Array.from({ length: 10 }, () => new Uint8Array(100));
    chunks[0]!.set(JPEG, 0);

    // The header claims the body is small; the stream says otherwise, and the
    // stream is what decides.
    await expect(
      readValidatedImage(streamRequest(chunks, { 'content-length': '10' }), { maxBytes: 500 }),
    ).rejects.toThrow(ApiError);
  });
});
