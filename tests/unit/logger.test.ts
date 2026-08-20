import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/worker/lib/logger';

describe('createLogger', () => {
  it('emits allowlisted technical metadata', () => {
    const sink = vi.fn();
    createLogger({ sink }).info({ event: 'request.completed', status: 200, durationMs: 12 });

    expect(sink).toHaveBeenCalledWith('info', {
      level: 'info',
      event: 'request.completed',
      status: 200,
      durationMs: 12,
    });
  });

  it('drops fields that are not on the allowlist', () => {
    const sink = vi.fn();
    const logger = createLogger({ sink });

    logger.info({
      event: 'ocr.completed',
      ...({
        citizenId: '1234567890123',
        firstName: 'redacted',
        address: 'redacted',
        formData: 'anything',
        ocrResult: 'anything',
      } as Record<string, string>),
    });

    const [, entry] = sink.mock.calls[0]!;
    expect(entry).toEqual({ level: 'info', event: 'ocr.completed' });
  });

  it('drops non-primitive values so nested payloads cannot leak', () => {
    const sink = vi.fn();
    createLogger({ sink }).info({
      event: 'provider.call',
      ...({ reason: { nested: 'payload' } } as unknown as { reason: string }),
    });

    const [, entry] = sink.mock.calls[0]!;
    expect(entry).toEqual({ level: 'info', event: 'provider.call' });
  });

  it('merges base fields from with()', () => {
    const sink = vi.fn();
    createLogger({ sink }).with({ requestId: 'req-1' }).warn({ event: 'request.failed' });

    expect(sink).toHaveBeenCalledWith('warn', {
      level: 'warn',
      requestId: 'req-1',
      event: 'request.failed',
    });
  });

  it('honours the minimum level', () => {
    const sink = vi.fn();
    const logger = createLogger({ sink, level: 'warn' });

    logger.debug({ event: 'noise' });
    logger.info({ event: 'noise' });
    logger.error({ event: 'request.failed' });

    expect(sink).toHaveBeenCalledTimes(1);
  });
});
